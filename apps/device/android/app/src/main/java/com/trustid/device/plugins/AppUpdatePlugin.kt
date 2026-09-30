package com.trustid.device.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.trustid.device.ota.TrustIdUpdater

/**
 * Exposes the native APK update channel to the web layer. Its presence also tells the
 * live web app that this shell updates itself (so no manual-install banner is shown).
 */
@CapacitorPlugin(name = "TrustIdAppUpdate")
class AppUpdatePlugin : Plugin() {

  @PluginMethod
  fun getStatus(call: PluginCall) {
    val ret = JSObject()
    for ((key, value) in TrustIdUpdater.status(context)) ret.put(key, value)
    call.resolve(ret)
  }

  @PluginMethod
  fun checkNow(call: PluginCall) {
    val ret = JSObject()
    ret.put("started", TrustIdUpdater.checkNow(context))
    call.resolve(ret)
  }
}
