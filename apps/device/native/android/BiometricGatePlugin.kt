package com.trustid.device.plugins

import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Hardware-backed biometric gate.
 * Default: BIOMETRIC_STRONG only (Class 3). Device credential allowed only when
 * allowDeviceCredential=true (explicit user opt-in from policy UI).
 */
@CapacitorPlugin(name = "TrustIdBiometricGate")
class BiometricGatePlugin : Plugin() {

  @PluginMethod
  fun getAvailability(call: PluginCall) {
    val mgr = BiometricManager.from(context)
    val strong = mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
    val weak = mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
    val enrolled = strong == BiometricManager.BIOMETRIC_SUCCESS ||
      weak == BiometricManager.BIOMETRIC_SUCCESS

    val ret = JSObject()
    ret.put("platform", "android")
    ret.put("available", strong == BiometricManager.BIOMETRIC_SUCCESS ||
      weak == BiometricManager.BIOMETRIC_SUCCESS)
    ret.put("enrolled", enrolled)
    ret.put(
      "strength",
      when {
        strong == BiometricManager.BIOMETRIC_SUCCESS -> "strong"
        weak == BiometricManager.BIOMETRIC_SUCCESS -> "weak"
        else -> "none"
      },
    )
    ret.put("hardwareBoundKeys", true)
    ret.put("appLockSupported", true)
    ret.put("secureWipeSupported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
    ret.put(
      "notes",
      listOf(
        "Keys bound via Android Keystore + BiometricPrompt CryptoObject.",
        "App Lock requires Accessibility permission.",
      ),
    )
    call.resolve(ret)
  }

  @PluginMethod
  fun authenticate(call: PluginCall) {
    val reason = call.getString("reason") ?: "Authenticate"
    val allowDevice = call.getBoolean("allowDeviceCredential", false) ?: false
    val strongOnly = call.getBoolean("strongOnly", true) ?: true

    val activity = activity as? FragmentActivity
    if (activity == null) {
      call.reject("Biometric gate requires a FragmentActivity host")
      return
    }

    var authenticators = if (strongOnly) {
      BiometricManager.Authenticators.BIOMETRIC_STRONG
    } else {
      BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.BIOMETRIC_WEAK
    }
    if (allowDevice) {
      authenticators = authenticators or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }

    val executor = ContextCompat.getMainExecutor(context)
    val prompt = BiometricPrompt(
      activity,
      executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          val type = when (result.authenticationType) {
            BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC -> "biometric_strong"
            BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL -> "device_credential"
            else -> "unknown"
          }
          if (!allowDevice && type == "device_credential") {
            call.reject("Device credential fallback is disabled")
            return
          }
          val ret = JSObject()
          ret.put("ok", true)
          ret.put("method", type)
          call.resolve(ret)
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          call.reject(errString.toString(), errorCode.toString())
        }

        override fun onAuthenticationFailed() {
          // Keep sheet open; OS will retry. No resolve/reject yet.
        }
      },
    )

    val builder = BiometricPrompt.PromptInfo.Builder()
      .setTitle("TrustID")
      .setSubtitle(reason)
      .setAllowedAuthenticators(authenticators)

    if (!allowDevice) {
      builder.setNegativeButtonText("Cancel")
    }

    activity.runOnUiThread {
      prompt.authenticate(builder.build())
    }
  }
}
