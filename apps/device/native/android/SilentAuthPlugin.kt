package com.trustid.device.plugins

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature

/**
 * Reference / sync copy of SilentAuthPlugin for apps/device/native.
 * Canonical runtime: apps/device/android/.../SilentAuthPlugin.kt
 */
@CapacitorPlugin(name = "TrustIdSilentAuth")
class SilentAuthPlugin : Plugin() {

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "com.trustid.silent.auth.v1"
    private const val KEY_ID = "android-silent-v1"
  }

  @PluginMethod
  fun getDeviceMeta(call: PluginCall) {
    val ret = JSObject()
    ret.put("platform", "android")
    ret.put("model", Build.MODEL ?: "unknown")
    ret.put("osVersion", Build.VERSION.RELEASE ?: "${Build.VERSION.SDK_INT}")
    call.resolve(ret)
  }

  @PluginMethod
  fun ensureHardwareKey(call: PluginCall) {
    try {
      ensureKeyExists()
      val pub = exportPublicKeySpki()
      val ret = JSObject()
      ret.put("keyId", KEY_ID)
      ret.put("publicKeySpki", pub)
      ret.put("algorithm", "ES256")
      call.resolve(ret)
    } catch (e: Exception) {
      call.reject(e.message ?: "Failed to ensure hardware key")
    }
  }

  @PluginMethod
  fun signChallenge(call: PluginCall) {
    val challenge = call.getString("challenge")
    if (challenge.isNullOrBlank()) {
      call.reject("challenge is required")
      return
    }
    val reason = call.getString("reason") ?: "Sign in to Trust ID"
    val activity = activity as? FragmentActivity
    if (activity == null) {
      call.reject("Silent auth requires a FragmentActivity host")
      return
    }
    try {
      ensureKeyExists()
    } catch (e: Exception) {
      call.reject(e.message ?: "Keystore unavailable")
      return
    }

    val signature = Signature.getInstance("SHA256withECDSA")
    val entry = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      .getEntry(KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
    if (entry == null) {
      call.reject("Silent auth private key missing")
      return
    }
    signature.initSign(entry.privateKey)
    val crypto = BiometricPrompt.CryptoObject(signature)
    val executor = ContextCompat.getMainExecutor(context)
    val prompt = BiometricPrompt(
      activity,
      executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          try {
            val sig = result.cryptoObject?.signature
              ?: throw IllegalStateException("Missing CryptoObject signature")
            sig.update(challenge.toByteArray(Charsets.UTF_8))
            val der = sig.sign()
            val ret = JSObject()
            ret.put("keyId", KEY_ID)
            ret.put(
              "signature",
              Base64.encodeToString(
                der,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
              ),
            )
            call.resolve(ret)
          } catch (e: Exception) {
            call.reject(e.message ?: "Sign failed")
          }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          call.reject(errString.toString())
        }

        override fun onAuthenticationFailed() {}
      },
    )
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Trust ID")
      .setSubtitle(reason)
      .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      .build()
    prompt.authenticate(info, crypto)
  }

  private fun ensureKeyExists() {
    val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    if (ks.containsAlias(KEY_ALIAS)) return
    val kpg = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      ANDROID_KEYSTORE,
    )
    val builder = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
    )
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }
    kpg.initialize(builder.build())
    kpg.generateKeyPair()
  }

  private fun exportPublicKeySpki(): String {
    val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    val pub = ks.getCertificate(KEY_ALIAS)?.publicKey
      ?: throw IllegalStateException("Public key missing")
    return Base64.encodeToString(
      pub.encoded,
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )
  }
}
