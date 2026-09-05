package com.trustid.device.plugins

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.InvalidKeyException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PublicKey
import java.security.Signature
import java.security.UnrecoverableKeyException

/**
 * Hardware-backed biometric gate + fingerprint backup template capture.
 *
 * TrustID ONLY accepts Class 3 (BIOMETRIC_STRONG) — fingerprint sensor or
 * 3D depth IR Face. Class 1/2 2D camera face unlock is never allowed.
 * Auth uses Android Keystore CryptoObject signatures.
 */
@CapacitorPlugin(name = "TrustIdBiometricGate")
class BiometricGatePlugin : Plugin() {

  companion object {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val FP_KEY_ALIAS = "trustid_fp_backup_v1"
    private const val AUTH_KEY_ALIAS = "trustid_bio_auth_v1"
    private const val SIGN_ALG = "SHA256withECDSA"
  }

  @PluginMethod
  fun getAvailability(call: PluginCall) {
    try {
      val mgr = BiometricManager.from(context)
      val strong = mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      val weak = mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
      val strongOk = strong == BiometricManager.BIOMETRIC_SUCCESS
      val weakOnly = !strongOk && weak == BiometricManager.BIOMETRIC_SUCCESS

      val ret = JSObject()
      ret.put("platform", "android")
      // TrustID availability = Class 3 only (never Class 1/2 face unlock).
      ret.put("available", strongOk)
      ret.put("enrolled", strongOk)
      ret.put(
        "strength",
        when {
          strongOk -> "strong"
          weakOnly -> "weak"
          else -> "none"
        },
      )
      ret.put("hardwareBoundKeys", true)
      ret.put("appLockSupported", true)
      ret.put("secureWipeSupported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
      val notes = JSArray()
      notes.put("Class 3 BIOMETRIC_STRONG only (fingerprint / 3D IR Face).")
      notes.put("2D optical camera face unlock is rejected.")
      notes.put("Keys bound via Android Keystore + BiometricPrompt CryptoObject.")
      if (weakOnly) {
        notes.put(
          "Only Class 1/2 biometrics enrolled. Register a fingerprint sensor or Class 3 Face in Android Settings.",
        )
      }
      if (!strongOk && !weakOnly) {
        notes.put(biometricStatusMessage(strong))
      }
      ret.put("notes", notes)
      call.resolve(ret)
    } catch (e: Exception) {
      val ret = JSObject()
      ret.put("platform", "android")
      ret.put("available", false)
      ret.put("enrolled", false)
      ret.put("strength", "none")
      ret.put("hardwareBoundKeys", false)
      ret.put("appLockSupported", false)
      ret.put("secureWipeSupported", false)
      val notes = JSArray()
      notes.put(e.message ?: "Availability check failed")
      ret.put("notes", notes)
      call.resolve(ret)
    }
  }

  @PluginMethod
  fun authenticate(call: PluginCall) {
    val reason = call.getString("reason") ?: "Authenticate"
    // Device PIN / Class 1-2 never unlock TrustID identity gates.
    runCryptoBiometricPrompt(
      call = call,
      reason = reason,
      keyAlias = AUTH_KEY_ALIAS,
      onSuccess = { method, publicKey ->
        val ret = JSObject()
        ret.put("ok", true)
        ret.put("method", method)
        ret.put(
          "publicKeyBase64",
          Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP),
        )
        call.resolve(ret)
      },
    )
  }

  /**
   * Prompt Class 3 biometric, then return a stable Keystore public-key
   * template for cloud fingerprint-backup enrollment and matching.
   */
  @PluginMethod
  fun captureFingerprintTemplate(call: PluginCall) {
    val reason = call.getString("reason")
      ?: "Scan your fingerprint to register a Trust ID backup"
    runCryptoBiometricPrompt(
      call = call,
      reason = reason,
      keyAlias = FP_KEY_ALIAS,
      onSuccess = { method, publicKey ->
        val ret = JSObject()
        ret.put("ok", true)
        ret.put("method", method)
        ret.put(
          "publicKeyBase64",
          Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP),
        )
        ret.put("keyAlias", FP_KEY_ALIAS)
        call.resolve(ret)
      },
    )
  }

  /** EncryptedSharedPreferences for session tokens / local secrets. */
  @PluginMethod
  fun storeSecure(call: PluginCall) {
    val key = call.getString("key")
    val value = call.getString("value") ?: ""
    if (key.isNullOrBlank()) {
      call.reject("key is required")
      return
    }
    try {
      prefs().edit().putString(key, value).apply()
      val ret = JSObject()
      ret.put("ok", true)
      call.resolve(ret)
    } catch (e: Exception) {
      call.reject(e.message ?: "storeSecure failed")
    }
  }

  @PluginMethod
  fun getSecure(call: PluginCall) {
    val key = call.getString("key")
    if (key.isNullOrBlank()) {
      call.reject("key is required")
      return
    }
    try {
      val ret = JSObject()
      ret.put("value", prefs().getString(key, null))
      call.resolve(ret)
    } catch (e: Exception) {
      call.reject(e.message ?: "getSecure failed")
    }
  }

  private fun prefs(): android.content.SharedPreferences {
    val masterKey = androidx.security.crypto.MasterKey.Builder(context)
      .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM)
      .build()
    return androidx.security.crypto.EncryptedSharedPreferences.create(
      context,
      "trustid_secure_prefs",
      masterKey,
      androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }

  private fun runCryptoBiometricPrompt(
    call: PluginCall,
    reason: String,
    keyAlias: String,
    onSuccess: (method: String, publicKey: PublicKey) -> Unit,
  ) {
    val activity = activity as? FragmentActivity
    if (activity == null) {
      call.reject("Biometric gate requires a FragmentActivity host")
      return
    }

    val mgr = BiometricManager.from(context)
    val strong = mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
    if (strong != BiometricManager.BIOMETRIC_SUCCESS) {
      val weak = mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
      val msg = if (weak == BiometricManager.BIOMETRIC_SUCCESS) {
        "Class 1/2 face unlock is not allowed. Enroll a fingerprint or Class 3 Face in Android Settings."
      } else {
        biometricStatusMessage(strong)
      }
      call.reject(msg)
      return
    }

    val crypto: BiometricPrompt.CryptoObject
    val publicKey: PublicKey
    try {
      val prepared = prepareCryptoObject(keyAlias)
      crypto = prepared.first
      publicKey = prepared.second
    } catch (e: Exception) {
      call.reject(
        "Keystore alias unavailable: ${e.message ?: "could not create biometric-bound key"}",
      )
      return
    }

    val executor = ContextCompat.getMainExecutor(context)
    val prompt = BiometricPrompt(
      activity,
      executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          try {
            if (result.cryptoObject?.signature == null) {
              call.reject("CryptoObject signature missing — Class 3 hardware binding required")
              return
            }
            val type = when (result.authenticationType) {
              BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC -> "biometric_strong"
              BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL -> {
                call.reject("Device credential / PIN fallback is disabled for TrustID")
                return
              }
              else -> "biometric_strong"
            }
            onSuccess(type, publicKey)
          } catch (e: Exception) {
            call.reject(e.message ?: "Biometric success handler failed")
          }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          call.reject(errString.toString(), errorCode.toString())
        }

        override fun onAuthenticationFailed() {
          // Keep sheet open; OS will retry.
        }
      },
    )

    val builder = BiometricPrompt.PromptInfo.Builder()
      .setTitle("TrustID Secure Access")
      .setSubtitle(reason)
      .setDescription("Use fingerprint or Class 3 Face ID — 2D camera unlock is disabled")
      .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      .setNegativeButtonText("Cancel")

    activity.runOnUiThread {
      try {
        prompt.authenticate(builder.build(), crypto)
      } catch (e: Exception) {
        call.reject(e.message ?: "Failed to show biometric prompt")
      }
    }
  }

  private fun prepareCryptoObject(
    keyAlias: String,
  ): Pair<BiometricPrompt.CryptoObject, PublicKey> {
    return try {
      initCrypto(keyAlias)
    } catch (e: Exception) {
      // Missing / invalidated alias after fingerprint change — recreate safely.
      deleteAliasQuietly(keyAlias)
      initCrypto(keyAlias)
    }
  }

  private fun initCrypto(
    keyAlias: String,
  ): Pair<BiometricPrompt.CryptoObject, PublicKey> {
    val publicKey = ensureBiometricKey(keyAlias)
    val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    val entry = ks.getEntry(keyAlias, null) as? KeyStore.PrivateKeyEntry
      ?: throw IllegalStateException("Keystore alias $keyAlias missing after create")
    val signature = Signature.getInstance(SIGN_ALG)
    try {
      signature.initSign(entry.privateKey)
    } catch (e: KeyPermanentlyInvalidatedException) {
      deleteAliasQuietly(keyAlias)
      val recreated = ensureBiometricKey(keyAlias)
      val again = ks.apply { load(null) }.getEntry(keyAlias, null) as KeyStore.PrivateKeyEntry
      signature.initSign(again.privateKey)
      return Pair(BiometricPrompt.CryptoObject(signature), recreated)
    } catch (e: InvalidKeyException) {
      deleteAliasQuietly(keyAlias)
      val recreated = ensureBiometricKey(keyAlias)
      val again = ks.apply { load(null) }.getEntry(keyAlias, null) as KeyStore.PrivateKeyEntry
      signature.initSign(again.privateKey)
      return Pair(BiometricPrompt.CryptoObject(signature), recreated)
    } catch (e: UnrecoverableKeyException) {
      deleteAliasQuietly(keyAlias)
      val recreated = ensureBiometricKey(keyAlias)
      val again = ks.apply { load(null) }.getEntry(keyAlias, null) as KeyStore.PrivateKeyEntry
      signature.initSign(again.privateKey)
      return Pair(BiometricPrompt.CryptoObject(signature), recreated)
    }
    return Pair(BiometricPrompt.CryptoObject(signature), publicKey)
  }

  private fun ensureBiometricKey(alias: String): PublicKey {
    val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    if (ks.containsAlias(alias)) {
      try {
        val entry = ks.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        if (entry != null) return entry.certificate.publicKey
      } catch (_: Exception) {
        deleteAliasQuietly(alias)
      }
    }

    val purposes = KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
    val builder = KeyGenParameterSpec.Builder(alias, purposes)
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(
        0,
        KeyProperties.AUTH_BIOMETRIC_STRONG,
      )
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }

    val kpg = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      KEYSTORE,
    )
    kpg.initialize(builder.build())
    return kpg.generateKeyPair().public
  }

  private fun deleteAliasQuietly(alias: String) {
    try {
      val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
      if (ks.containsAlias(alias)) ks.deleteEntry(alias)
    } catch (_: Exception) {
      // ignore — next ensure will recreate
    }
  }

  private fun biometricStatusMessage(code: Int): String {
    return when (code) {
      BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
        "No Class 3 biometric hardware on this device"
      BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ->
        "Biometric hardware temporarily unavailable"
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
        "No fingerprint / Class 3 Face enrolled. Add one in Android Settings."
      BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
        "Device security update required before biometrics can be used"
      BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED ->
        "Class 3 biometrics unsupported on this device"
      else -> "Class 3 biometrics unavailable (code $code)"
    }
  }
}
