package com.trustid.device.plugins

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
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
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * TrustID Master Device key (step-up approvals).
 *
 * - ECDSA P-256 in Android Keystore, non-exportable, StrongBox when available, otherwise TEE.
 * - Generated with TrustID's attestation challenge so the server can verify Android Key
 *   Attestation (hardware level, per-use biometric, app identity, verified boot).
 * - Every signature needs a fresh Class 3 biometric (per-use auth, no time window, no PIN).
 * - Software-only keystores are refused: the key is deleted and enrollment fails safely.
 * - The enrolled key alias is kept in app preferences only after the server confirms enrollment.
 */
@CapacitorPlugin(name = "TrustIdMasterDevice")
class MasterDevicePlugin : Plugin() {
  companion object {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val PREFS = "trustid_master_device"
    private const val PREF_ACTIVE_ALIAS = "active_alias"
    private const val ALIAS_PREFIX = "trustid_md_"
    /** Passkeys through Credential Manager and reliable per-use biometric keys need Android 9+. */
    private const val MIN_SDK = Build.VERSION_CODES.P
  }

  private fun b64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  /** Whether this phone can hold a Master Device key at all (Android version + Class 3 biometric). */
  @PluginMethod
  fun getSupport(call: PluginCall) {
    val ret = JSObject()
    val sdkOk = Build.VERSION.SDK_INT >= MIN_SDK
    val biometric = BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
    ret.put("supported", sdkOk && biometric == BiometricManager.BIOMETRIC_SUCCESS)
    ret.put("sdk", Build.VERSION.SDK_INT)
    ret.put("strongBiometric", biometric == BiometricManager.BIOMETRIC_SUCCESS)
    ret.put("biometricStatus", biometric)
    ret.put("activeAlias", prefs().getString(PREF_ACTIVE_ALIAS, null))
    call.resolve(ret)
  }

  /**
   * Generate a new (pending) Master Device key bound to TrustID's attestation challenge.
   * Returns the alias, the SPKI public key, the attestation chain and the measured security level.
   */
  @PluginMethod
  fun generateKey(call: PluginCall) {
    val challengeB64 = call.getString("attestationChallenge")
    if (challengeB64.isNullOrBlank()) return call.reject("attestationChallenge is required", "invalid_request")
    if (Build.VERSION.SDK_INT < MIN_SDK) return call.reject("This Android version cannot hold a Master Device key", "unsupported_device")
    if (BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) != BiometricManager.BIOMETRIC_SUCCESS) {
      return call.reject("Set up a fingerprint or strong face unlock first", "biometric_unavailable")
    }
    val challenge = try {
      Base64.decode(challengeB64, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    } catch (e: IllegalArgumentException) {
      return call.reject("attestationChallenge is not base64url", "invalid_request")
    }
    val alias = ALIAS_PREFIX + System.currentTimeMillis()
    try {
      generate(alias, challenge, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && context.packageManager.hasSystemFeature("android.hardware.strongbox_keystore"))
    } catch (e: StrongBoxUnavailableException) {
      deleteQuietly(alias)
      try {
        generate(alias, challenge, strongBox = false)
      } catch (e2: Exception) {
        deleteQuietly(alias)
        return call.reject("Could not create the Master Device key", "keygen_failed", e2)
      }
    } catch (e: Exception) {
      deleteQuietly(alias)
      return call.reject("Could not create the Master Device key", "keygen_failed", e)
    }

    val level = securityLevel(alias)
    // Emulators have no secure hardware. Debug builds on an emulator may opt in (explicit flag) so
    // the rest of the flow can be exercised; the TrustID API still rejects software attestations.
    val emulatorTest = call.getBoolean("emulatorTestAllowSoftware", false) == true && com.trustid.device.BuildConfig.DEBUG && isEmulator()
    if (level == "software" && !emulatorTest) {
      // Never fall back to an extractable / software key.
      deleteQuietly(alias)
      return call.reject("This phone has no secure hardware for a Master Device key", "insecure_hardware")
    }
    val ks = keyStore()
    val chain = ks.getCertificateChain(alias) ?: run {
      deleteQuietly(alias)
      return call.reject("Key attestation is unavailable on this phone", "attestation_unavailable")
    }
    val attestation = JSArray()
    chain.forEach { attestation.put(Base64.encodeToString(it.encoded, Base64.NO_WRAP)) }
    val ret = JSObject()
    ret.put("alias", alias)
    ret.put("publicKey", b64url(chain[0].publicKey.encoded))
    ret.put("attestation", attestation)
    ret.put("securityLevel", level)
    ret.put("emulatorTest", emulatorTest)
    call.resolve(ret)
  }

  private fun generate(alias: String, challenge: ByteArray, strongBox: Boolean) {
    val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
      .setAttestationChallenge(challenge)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // Timeout 0 = every signature needs its own biometric; strong biometric only (no PIN).
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
    val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
    kpg.initialize(builder.build())
    kpg.generateKeyPair()
  }

  /** Measured, not assumed: "strongbox", "tee" or "software". */
  private fun securityLevel(alias: String): String {
    val key = keyStore().getKey(alias, null) as PrivateKey
    val info = KeyFactory.getInstance(key.algorithm, KEYSTORE).getKeySpec(key, KeyInfo::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        else -> "software"
      }
    }
    @Suppress("DEPRECATION")
    return if (info.isInsideSecureHardware) "tee" else "software"
  }

  /** After the server confirmed enrollment: this alias becomes the Master Device key. */
  @PluginMethod
  fun activateKey(call: PluginCall) {
    val alias = call.getString("alias") ?: return call.reject("alias is required", "invalid_request")
    if (!alias.startsWith(ALIAS_PREFIX) || !keyStore().containsAlias(alias)) return call.reject("Unknown key", "unknown_key")
    val previous = prefs().getString(PREF_ACTIVE_ALIAS, null)
    prefs().edit().putString(PREF_ACTIVE_ALIAS, alias).apply()
    if (previous != null && previous != alias) deleteQuietly(previous)
    call.resolve()
  }

  /** Discard a key (failed enrollment, or after revocation). */
  @PluginMethod
  fun deleteKey(call: PluginCall) {
    val alias = call.getString("alias") ?: prefs().getString(PREF_ACTIVE_ALIAS, null)
    if (alias != null) {
      deleteQuietly(alias)
      if (prefs().getString(PREF_ACTIVE_ALIAS, null) == alias) prefs().edit().remove(PREF_ACTIVE_ALIAS).apply()
    }
    call.resolve()
  }

  /**
   * Sign exactly `payload` with the Master Device key after a fresh Class 3 biometric prompt
   * showing `title` / `subtitle` (what is being approved). Uses `alias`, else the active key.
   */
  @PluginMethod
  fun sign(call: PluginCall) {
    val payload = call.getString("payload") ?: return call.reject("payload is required", "invalid_request")
    val alias = call.getString("alias") ?: prefs().getString(PREF_ACTIVE_ALIAS, null)
      ?: return call.reject("No Master Device key on this phone", "no_key")
    val signature = try {
      val key = keyStore().getKey(alias, null) as? PrivateKey ?: return call.reject("No Master Device key on this phone", "no_key")
      Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
    } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
      // Biometric enrollment changed: the key is gone for good; the device must be re-enrolled.
      return call.reject("Your fingerprints or face changed. Enroll this phone again.", "key_invalidated", e)
    } catch (e: Exception) {
      return call.reject("The Master Device key is unavailable", "key_unavailable", e)
    }
    val activity = activity as? FragmentActivity ?: return call.reject("No activity", "no_activity")
    activity.runOnUiThread {
      val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(context), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          try {
            val sig = result.cryptoObject?.signature ?: return call.reject("No signature object", "sign_failed")
            sig.update(payload.toByteArray(Charsets.UTF_8))
            val ret = JSObject()
            ret.put("signature", b64url(sig.sign()))
            call.resolve(ret)
          } catch (e: Exception) {
            call.reject("Signing failed", "sign_failed", e)
          }
        }
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          val code = if (errorCode == BiometricPrompt.ERROR_USER_CANCELED || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON) "cancelled" else "biometric_error"
          call.reject(errString.toString(), code)
        }
      })
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(call.getString("title") ?: "Approve with your Master Device")
        .setSubtitle(call.getString("subtitle") ?: "")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButtonText("Cancel")
        .setConfirmationRequired(true)
        .build()
      prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
    }
  }

  private fun isEmulator(): Boolean =
    Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish" || Build.FINGERPRINT.startsWith("generic") || Build.PRODUCT.contains("sdk_gphone")

  private fun deleteQuietly(alias: String) {
    try {
      keyStore().deleteEntry(alias)
    } catch (_: Exception) {
    }
  }
}
