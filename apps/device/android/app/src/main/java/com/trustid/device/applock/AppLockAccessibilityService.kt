package com.trustid.device.applock

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.content.SharedPreferences
import android.view.accessibility.AccessibilityEvent
import org.json.JSONArray
import org.json.JSONObject

/**
 * Foreground-package monitor. When a locked app comes to the foreground and the
 * post-auth grace window has expired, launches [AppLockOverlayActivity].
 *
 * Best-effort shield — users can disable Accessibility; treat as consumer deterrence,
 * not a hardened MDM boundary.
 */
class AppLockAccessibilityService : AccessibilityService() {

  companion object {
    const val PREFS = "trustid_app_lock"
    const val KEY_POLICY = "policy_json"
    const val KEY_GRACE_UNTIL = "grace_until_ms"
    @Volatile var instance: AppLockAccessibilityService? = null
  }

  private lateinit var prefs: SharedPreferences

  override fun onServiceConnected() {
    instance = this
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    serviceInfo = serviceInfo.apply {
      eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
      feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
      flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
      notificationTimeout = 100
    }
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
    val pkg = event.packageName?.toString() ?: return
    if (pkg == packageName) return

    val policy = readPolicy() ?: return
    if (!policy.enabled) return
    if (!policy.packages.contains(pkg)) return

    val graceUntil = prefs.getLong(KEY_GRACE_UNTIL, 0L)
    if (System.currentTimeMillis() < graceUntil) return

    val intent = Intent(this, AppLockOverlayActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      putExtra(AppLockOverlayActivity.EXTRA_PACKAGE, pkg)
      putExtra(AppLockOverlayActivity.EXTRA_ALLOW_DEVICE, policy.allowDeviceCredential)
      putExtra(AppLockOverlayActivity.EXTRA_STRONG_ONLY, policy.biometricStrongOnly)
      putExtra(AppLockOverlayActivity.EXTRA_GRACE_MS, policy.postAuthGraceMs)
    }
    startActivity(intent)
  }

  override fun onInterrupt() {}

  override fun onDestroy() {
    instance = null
    super.onDestroy()
  }

  private fun readPolicy(): PolicySnapshot? {
    val raw = prefs.getString(KEY_POLICY, null) ?: return null
    return try {
      val o = JSONObject(raw)
      val apps = o.optJSONArray("apps") ?: JSONArray()
      val packages = mutableSetOf<String>()
      for (i in 0 until apps.length()) {
        packages.add(apps.getJSONObject(i).getString("packageId"))
      }
      PolicySnapshot(
        enabled = o.optBoolean("enabled", false),
        allowDeviceCredential = o.optBoolean("allowDeviceCredential", false),
        biometricStrongOnly = o.optBoolean("biometricStrongOnly", true),
        postAuthGraceMs = o.optLong("postAuthGraceMs", 8_000L),
        packages = packages,
      )
    } catch (_: Exception) {
      null
    }
  }

  data class PolicySnapshot(
    val enabled: Boolean,
    val allowDeviceCredential: Boolean,
    val biometricStrongOnly: Boolean,
    val postAuthGraceMs: Long,
    val packages: Set<String>,
  )
}
