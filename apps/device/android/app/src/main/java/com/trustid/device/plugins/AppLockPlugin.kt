package com.trustid.device.plugins

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import android.view.accessibility.AccessibilityManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.trustid.device.applock.AppLockService
import com.trustid.device.applock.OverlayGuardActivity
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

@CapacitorPlugin(name = "TrustIdAppLock")
class AppLockPlugin : Plugin() {

  @PluginMethod
  fun getPolicy(call: PluginCall) {
    val raw = context.getSharedPreferences(AppLockService.PREFS, Context.MODE_PRIVATE)
      .getString(AppLockService.KEY_POLICY, null)
    if (raw == null) {
      val empty = JSObject()
      empty.put("enabled", false)
      empty.put("allowDeviceCredential", false)
      empty.put("biometricStrongOnly", true)
      empty.put("postAuthGraceMs", 8000)
      empty.put("lockOnBackground", true)
      empty.put("apps", JSArray())
      call.resolve(empty)
      return
    }
    call.resolve(JSObject(raw))
  }

  @PluginMethod
  fun setPolicy(call: PluginCall) {
    val policy = call.getObject("policy")
      ?: return call.reject("policy required")
    syncLockedPackagesFromPolicy(policy)
    context.getSharedPreferences(AppLockService.PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(AppLockService.KEY_POLICY, policy.toString())
      .apply()
    call.resolve()
  }

  /**
   * Synchronize the native OS lock registry with an explicit package ID list.
   * Mirrors packages into policy.apps when possible and KEY_LOCKED_PACKAGES.
   */
  @PluginMethod
  fun setLockedApps(call: PluginCall) {
    val arr = call.getArray("packages")
      ?: return call.reject("packages required")
    val packages = mutableListOf<String>()
    for (i in 0 until arr.length()) {
      val v = arr.getString(i)?.trim().orEmpty()
      if (v.isNotEmpty()) packages.add(v)
    }
    val prefs = context.getSharedPreferences(AppLockService.PREFS, Context.MODE_PRIVATE)
    val flat = JSONArray(packages)
    val policyRaw = prefs.getString(AppLockService.KEY_POLICY, null)
    val policy = if (policyRaw != null) JSONObject(policyRaw) else JSONObject().apply {
      put("enabled", true)
      put("allowDeviceCredential", false)
      put("biometricStrongOnly", true)
      put("postAuthGraceMs", 8000)
      put("lockOnBackground", true)
    }
    val existingApps = policy.optJSONArray("apps") ?: JSONArray()
    val nameByPkg = mutableMapOf<String, String>()
    for (i in 0 until existingApps.length()) {
      val o = existingApps.getJSONObject(i)
      nameByPkg[o.getString("packageId")] = o.optString("displayName", o.getString("packageId"))
    }
    val pm = context.packageManager
    val nextApps = JSONArray()
    val now = java.time.Instant.now().toString()
    for (pkg in packages.distinct()) {
      val label = nameByPkg[pkg] ?: runCatching {
        val ai = pm.getApplicationInfo(pkg, 0)
        pm.getApplicationLabel(ai).toString()
      }.getOrDefault(pkg)
      val o = JSONObject()
      o.put("packageId", pkg)
      o.put("displayName", label)
      o.put("addedAt", now)
      nextApps.put(o)
    }
    policy.put("apps", nextApps)
    if (packages.isNotEmpty()) policy.put("enabled", true)

    prefs.edit()
      .putString(AppLockService.KEY_LOCKED_PACKAGES, flat.toString())
      .putString(AppLockService.KEY_POLICY, policy.toString())
      .apply()

    val ret = JSObject()
    ret.put("ok", true)
    ret.put("count", packages.size)
    call.resolve(ret)
  }

  /**
   * Query launchable installed applications for the in-app picker.
   * Requires QUERY_ALL_PACKAGES on Android 11+ (declared in manifest).
   */
  @PluginMethod
  fun getInstalledApps(call: PluginCall) {
    val includeIcons = call.getBoolean("includeIcons", false) ?: false
    val pm = context.packageManager
    val intent = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
    val resolves = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
    val apps = JSArray()
    val seen = HashSet<String>()

    for (ri in resolves) {
      val pkg = ri.activityInfo?.packageName ?: continue
      if (!seen.add(pkg)) continue
      if (pkg == context.packageName) continue
      val ai = ri.activityInfo.applicationInfo ?: continue
      if ((ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
        (ai.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0
      ) {
        // Still include system launchers users may want to lock (Settings, etc.)
      }
      val label = ri.loadLabel(pm)?.toString() ?: pkg
      val row = JSObject()
      row.put("packageId", pkg)
      row.put("displayName", label)
      row.put("systemApp", (ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0)
      if (includeIcons) {
        try {
          val icon = ri.loadIcon(pm)
          row.put("iconBase64", drawableToPngBase64(icon))
        } catch (_: Exception) {
          /* skip icon */
        }
      }
      apps.put(row)
    }

    val ret = JSObject()
    ret.put("apps", apps)
    ret.put("platform", "android")
    call.resolve(ret)
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
  fun openOverlayPermissionSettings(call: PluginCall) {
    val intent = Intent(
      Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      Uri.parse("package:${context.packageName}"),
    ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    context.startActivity(intent)
    call.resolve()
  }

  @PluginMethod
  fun canDrawOverlays(call: PluginCall) {
    val ret = JSObject()
    ret.put("granted", Settings.canDrawOverlays(context))
    call.resolve(ret)
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
    val raw = context.getSharedPreferences(AppLockService.PREFS, Context.MODE_PRIVATE)
      .getString(AppLockService.KEY_POLICY, null)
    val policy = if (raw != null) JSONObject(raw) else JSONObject()
    val intent = Intent(context, OverlayGuardActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(OverlayGuardActivity.EXTRA_PACKAGE, packageId)
      putExtra(
        OverlayGuardActivity.EXTRA_ALLOW_DEVICE,
        policy.optBoolean("allowDeviceCredential", false),
      )
      putExtra(
        OverlayGuardActivity.EXTRA_STRONG_ONLY,
        policy.optBoolean("biometricStrongOnly", true),
      )
      putExtra(
        OverlayGuardActivity.EXTRA_GRACE_MS,
        policy.optLong("postAuthGraceMs", 8_000L),
      )
    }
    context.startActivity(intent)
    val ret = JSObject()
    ret.put("ok", true)
    call.resolve(ret)
  }

  @PluginMethod
  fun isDuressBiometricConfigured(call: PluginCall) {
    val ret = JSObject()
    ret.put("configured", false)
    call.resolve(ret)
  }

  private fun syncLockedPackagesFromPolicy(policy: JSObject) {
    try {
      val apps = policy.getJSONArray("apps") ?: return
      val packages = JSONArray()
      for (i in 0 until apps.length()) {
        packages.put(apps.getJSONObject(i).getString("packageId"))
      }
      context.getSharedPreferences(AppLockService.PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString(AppLockService.KEY_LOCKED_PACKAGES, packages.toString())
        .apply()
    } catch (_: Exception) {
      /* ignore */
    }
  }

  private fun drawableToPngBase64(drawable: Drawable): String {
    val bmp = when (drawable) {
      is BitmapDrawable -> drawable.bitmap
      else -> {
        val w = (drawable.intrinsicWidth.takeIf { it > 0 } ?: 96).coerceAtMost(128)
        val h = (drawable.intrinsicHeight.takeIf { it > 0 } ?: 96).coerceAtMost(128)
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(b)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
        b
      }
    }
    val scaled = if (bmp.width > 96 || bmp.height > 96) {
      Bitmap.createScaledBitmap(bmp, 96, 96, true)
    } else bmp
    val out = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.PNG, 85, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }
}
