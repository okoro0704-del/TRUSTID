package com.trustid.device.plugins

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.trustid.device.biometric.NativeBiometricAssets

/**
 * Tells the web SDK which biometric release files this APK carries and where
 * they are served (NativeBiometricAssetBridge in @trustid/sdk). The SDK uses
 * them instead of downloading the models; it still verifies every byte.
 *
 * `baseUrl` is a path: the SDK resolves it against the page origin, so the
 * request stays same-origin whichever host the shell loads.
 */
@CapacitorPlugin(name = "TrustIdBiometricAssets")
class BiometricAssetsPlugin : Plugin() {

  @PluginMethod
  fun getBundle(call: PluginCall) {
    val ret = JSObject()
    ret.put("apiVersion", NativeBiometricAssets.API_VERSION)
    ret.put("baseUrl", NativeBiometricAssets.URL_PREFIX)
    ret.put("assets", JSArray(NativeBiometricAssets.bundledDirs(context.assets)))
    call.resolve(ret)
  }
}
