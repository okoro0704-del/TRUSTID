package com.trustid.device.plugins

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import androidx.security.crypto.EncryptedFile
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * AES-GCM media vault with DEK in Android Keystore (user authentication required).
 * Ciphertext files live only under app-private storage (invisible to MediaStore pickers).
 */
@CapacitorPlugin(name = "TrustIdMediaVault")
class MediaVaultPlugin : Plugin() {

  companion object {
    private const val KEY_ALIAS = "trustid_vault_dek_v1"
    private const val PREFS = "trustid_vault_catalog"
    private const val DIR = "vault"
    private const val GCM_IV = 12
    private const val GCM_TAG = 128
  }

  @PluginMethod
  fun list(call: PluginCall) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val items = JSArray()
    prefs.all.forEach { (_, value) ->
      if (value is String) {
        items.put(JSObject(value))
      }
    }
    val ret = JSObject()
    ret.put("items", items)
    call.resolve(ret)
  }

  @PluginMethod
  fun importMedia(call: PluginCall) {
    val b64 = call.getString("bytesBase64") ?: return call.reject("bytesBase64 required")
    val mime = call.getString("mimeType") ?: "application/octet-stream"
    val name = call.getString("displayName") ?: "media"
    val wipeUri = call.getString("wipeSourceUri")
    val plain = Base64.decode(b64, Base64.DEFAULT)

    authenticateForCipher(Cipher.ENCRYPT_MODE, call) { cipher ->
      try {
        val id = UUID.randomUUID().toString()
        val iv = cipher.iv
        val cipherBytes = cipher.doFinal(plain)
        val envelope = ByteArray(iv.size + cipherBytes.size)
        System.arraycopy(iv, 0, envelope, 0, iv.size)
        System.arraycopy(cipherBytes, 0, envelope, iv.size, cipherBytes.size)

        val dir = File(context.filesDir, DIR).apply { mkdirs() }
        val out = File(dir, "$id.tvm")
        out.writeBytes(envelope)

        val hash = sha256Hex(plain)
        plain.fill(0)

        val kind = when {
          mime.startsWith("image/") -> "image"
          mime.startsWith("video/") -> "video"
          else -> "other"
        }
        val meta = JSONObject()
        meta.put("id", id)
        meta.put("kind", kind)
        meta.put("mimeType", mime)
        meta.put("byteLength", cipherBytes.size)
        meta.put("contentHash", hash)
        meta.put("createdAt", java.time.Instant.now().toString())
        meta.put("displayName", name)

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putString(id, meta.toString())
          .apply()

        var wiped = false
        var wipeNote: String? = null
        if (!wipeUri.isNullOrBlank()) {
          val result = requestWipe(Uri.parse(wipeUri))
          wiped = result.first
          wipeNote = result.second
        } else {
          wipeNote = "Pass wipeSourceUri (content://) to schedule MediaStore delete."
        }

        val ret = JSObject()
        ret.put("item", JSObject(meta.toString()))
        ret.put("sourceWiped", wiped)
        if (wipeNote != null) ret.put("wipeNote", wipeNote)
        call.resolve(ret)
      } catch (e: Exception) {
        call.reject("Vault import failed: ${e.message}", e)
      }
    }
  }

  @PluginMethod
  fun decrypt(call: PluginCall) {
    val id = call.getString("id") ?: return call.reject("id required")
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val metaRaw = prefs.getString(id, null) ?: return call.reject("Not found")
    val meta = JSONObject(metaRaw)
    val file = File(File(context.filesDir, DIR), "$id.tvm")
    if (!file.exists()) return call.reject("Ciphertext missing")

    val envelope = file.readBytes()
    if (envelope.size < GCM_IV + 16) return call.reject("Corrupt envelope")

    authenticateForCipher(Cipher.DECRYPT_MODE, call, envelope.copyOfRange(0, GCM_IV)) { cipher ->
      try {
        val plain = cipher.doFinal(envelope, GCM_IV, envelope.size - GCM_IV)
        val ret = JSObject()
        ret.put("bytesBase64", Base64.encodeToString(plain, Base64.NO_WRAP))
        ret.put("mimeType", meta.getString("mimeType"))
        ret.put("displayName", meta.getString("displayName"))
        call.resolve(ret)
        plain.fill(0)
      } catch (e: Exception) {
        call.reject("Decrypt failed: ${e.message}", e)
      }
    }
  }

  @PluginMethod
  fun remove(call: PluginCall) {
    val id = call.getString("id") ?: return call.reject("id required")
    File(File(context.filesDir, DIR), "$id.tvm").delete()
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(id).apply()
    call.resolve()
  }

  private fun ensureKey(): SecretKey {
    val ks = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = ks.getKey(KEY_ALIAS, null) as? SecretKey
    if (existing != null) return existing

    val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val spec = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          setUserAuthenticationParameters(
            0,
            KeyProperties.AUTH_BIOMETRIC_STRONG,
          )
        }
      }
      .build()
    keyGen.init(spec)
    return keyGen.generateKey()
  }

  private fun authenticateForCipher(
    op: Int,
    call: PluginCall,
    iv: ByteArray? = null,
    onReady: (Cipher) -> Unit,
  ) {
    val activity = activity as? FragmentActivity
      ?: return call.reject("FragmentActivity required")
    val key = try {
      ensureKey()
    } catch (e: Exception) {
      return call.reject("Keystore DEK unavailable: ${e.message}", e)
    }

    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    if (op == Cipher.ENCRYPT_MODE) {
      cipher.init(Cipher.ENCRYPT_MODE, key)
    } else {
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG, iv))
    }

    val crypto = BiometricPrompt.CryptoObject(cipher)
    val executor = androidx.core.content.ContextCompat.getMainExecutor(context)
    val prompt = BiometricPrompt(
      activity,
      executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          val unlocked = result.cryptoObject?.cipher
          if (unlocked == null) {
            call.reject("CryptoObject missing after biometric auth")
            return
          }
          onReady(unlocked)
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          call.reject(errString.toString(), errorCode.toString())
        }
      },
    )

    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle("TrustID Vault")
      .setSubtitle("Biometric required to use vault key")
      .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG)
      .setNegativeButtonText("Cancel")
      .build()

    activity.runOnUiThread { prompt.authenticate(info, crypto) }
  }

  private fun requestWipe(uri: Uri): Pair<Boolean, String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return false to "MediaStore.createDeleteRequest requires Android 11+"
    }
    return try {
      val pending = MediaStore.createDeleteRequest(context.contentResolver, listOf(uri))
      // Host Activity must launch pending.intent; Capacitor bridge should expose startIntentSender.
      // We mark as scheduled  UI layer completes the system confirmation.
      activity.startIntentSenderForResult(
        pending.intentSender,
        19001,
        null,
        0,
        0,
        0,
      )
      true to "System delete confirmation presented"
    } catch (e: Exception) {
      false to "Wipe failed: ${e.message}"
    }
  }

  private fun sha256Hex(data: ByteArray): String {
    val d = MessageDigest.getInstance("SHA-256").digest(data)
    return d.joinToString("") { "%02x".format(it) }
  }
}
