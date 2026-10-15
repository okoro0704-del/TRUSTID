package com.trustid.device.plugins

import android.os.Build
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Native passkey assertions through Android Credential Manager (Option B).
 *
 * The TrustID web app runs in a WebView, where WebAuthn depends on the installed WebView and
 * AndroidX WebKit versions. Credential Manager is the supported path: it shows the system passkey
 * sheet (with user verification) for TrustID's RP ID. Android only releases the passkey to this
 * app if the RP domain's Digital Asset Links lists this package and signing certificate, and
 * the assertion's clientDataJSON carries the app origin (android:apk-key-hash:...), which the
 * TrustID API accepts only for configured signing certificates.
 *
 * Input: the WebAuthn request JSON the TrustID API issued (PublicKeyCredentialRequestOptionsJSON).
 * Output: the AuthenticationResponseJSON, passed unchanged to the API for verification.
 */
@CapacitorPlugin(name = "TrustIdPasskey")
class PasskeyPlugin : Plugin() {
  @PluginMethod
  fun isSupported(call: PluginCall) {
    val ret = JSObject()
    ret.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    call.resolve(ret)
  }

  @PluginMethod
  fun getAssertion(call: PluginCall) {
    val requestJson = call.getString("requestJson") ?: return call.reject("requestJson is required", "invalid_request")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return call.reject("Passkeys need Android 9 or later", "unsupported_device")
    val activity = activity ?: return call.reject("No activity", "no_activity")
    val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
    CredentialManager.create(activity).getCredentialAsync(
      activity,
      request,
      CancellationSignal(),
      ContextCompat.getMainExecutor(activity),
      object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
        override fun onResult(result: GetCredentialResponse) {
          val credential = result.credential
          if (credential !is PublicKeyCredential) return call.reject("Not a passkey", "unexpected_credential")
          val ret = JSObject()
          ret.put("responseJson", credential.authenticationResponseJson)
          call.resolve(ret)
        }

        override fun onError(e: GetCredentialException) {
          when (e) {
            is GetCredentialCancellationException -> call.reject("Cancelled", "cancelled")
            is NoCredentialException -> call.reject("No TrustID passkey on this phone", "no_credential")
            else -> call.reject(e.message ?: "Passkey request failed", "passkey_error")
          }
        }
      },
    )
  }
}
