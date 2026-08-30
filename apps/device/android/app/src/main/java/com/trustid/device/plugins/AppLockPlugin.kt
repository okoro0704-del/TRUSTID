package com.trustid.device.plugins

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.trustid.device.applock.AppLockAccessibilityService
import com.trustid.device.applock.AppLockOverlayActivity
import org.json.JSONObject

@CapacitorPlugin(name = "TrustIdAppLock")
class AppLockPlugin : Plugin() {

  @PluginMethod
  fun getPolicy(call: PluginCall) {
    val raw = context.getSharedPreferences(AppLockAccessibilityService.PREFS, Context.MODE_PRIVATE)
      .getString(AppLockAccessibilityService.KEY_POLICY, null)
    if (raw == null) {
      val empty = JSObject()
      empty.put("enabled", false)
      empty.put("allowDeviceCredential", false)
      empty.put("biometricStrongOnly", true)
      empty.put("postAuthGraceMs", 8000)
      empty.put("lockOnBackground", true)
      empty.put("apps", com.getcapacitor.JSArray())
      call.resolve(empty)
      return
    }
    call.resolve(JSObject(raw))
  }

  @PluginMethod
  fun setPolicy(call: PluginCall) {
    val policy = call.getObject("policy")
      ?: return call.reject("policy required")
    context.getSharedPreferences(AppLockAccessibilityService.PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(AppLockAccessibilityService.KEY_POLICY, policy.toString())
      .apply()
    call.resolve()
  }

  @PluginMethod
  fun openAccessibilitySettings(call: PluginCall) {
    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
    call.resolve()
  }

  @PluginMethod
  fun isAccessibilityEnabled(call: PluginCall) {
    val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    val enabled = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
      .any { it.resolveInfo.serviceInfo.packageName == context.packageName }
    val ret = JSObject()
    ret.put("enabled", enabled)
    call.resolve(ret)
  }

  @PluginMethod
  fun challengeNow(call: PluginCall) {
    val packageId = call.getString("packageId") ?: "manual"
    val raw = context.getSharedPreferences(AppLockAccessibilityService.PREFS, Context.MODE_PRIVATE)
      .getString(AppLockAccessibilityService.KEY_POLICY, null)
    val policy = if (raw != null) JSONObject(raw) else JSONObject()
    val intent = Intent(context, AppLockOverlayActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(AppLockOverlayActivity.EXTRA_PACKAGE, packageId)
      putExtra(
        AppLockOverlayActivity.EXTRA_ALLOW_DEVICE,
        policy.optBoolean("allowDeviceCredential", false),
      )
      putExtra(
        AppLockOverlayActivity.EXTRA_STRONG_ONLY,
        policy.optBoolean("biometricStrongOnly", true),
      )
      putExtra(
        AppLockOverlayActivity.EXTRA_GRACE_MS,
        policy.optLong("postAuthGraceMs", 8_000L),
      )
    }
    context.startActivity(intent)
    val ret = JSObject()
    ret.put("ok", true)
    call.resolve(ret)
  }
}
