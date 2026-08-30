package com.trustid.device.applock

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import org.json.JSONArray
import org.json.JSONObject

/**
 * Deep OS App Locker enforcement service.
 *
 * Monitors window changes for locked packages and, within ~10ms of detection,
 * draws a SYSTEM_ALERT_WINDOW biometric guard (when overlay permission is granted)
 * and launches [OverlayGuardActivity] as a hardened FLAG_SECURE fallback.
 */
open class AppLockService : AccessibilityService() {

  companion object {
    const val PREFS = "trustid_app_lock"
    const val KEY_POLICY = "policy_json"
    const val KEY_GRACE_UNTIL = "grace_until_ms"
    const val KEY_LOCKED_PACKAGES = "locked_packages_json"

    @Volatile
    var instance: AppLockService? = null

    fun readLockedPackages(prefs: SharedPreferences): Set<String> {
      val packages = mutableSetOf<String>()
      val policy = prefs.getString(KEY_POLICY, null)
      var enabled = true
      if (policy != null) {
        try {
          val o = JSONObject(policy)
          enabled = o.optBoolean("enabled", false)
          val apps = o.optJSONArray("apps") ?: JSONArray()
          for (i in 0 until apps.length()) {
            packages.add(apps.getJSONObject(i).getString("packageId"))
          }
        } catch (_: Exception) {
          /* ignore */
        }
      }
      val flat = prefs.getString(KEY_LOCKED_PACKAGES, null)
      if (flat != null) {
        try {
          val arr = JSONArray(flat)
          for (i in 0 until arr.length()) packages.add(arr.getString(i))
        } catch (_: Exception) {
          /* ignore */
        }
      }
      return if (enabled) packages else emptySet()
    }
  }

  private lateinit var prefs: SharedPreferences
  private val mainHandler = Handler(Looper.getMainLooper())
  private var lastTriggerPkg: String? = null
  private var lastTriggerAt = 0L

  override fun onServiceConnected() {
    instance = this
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    serviceInfo = serviceInfo.apply {
      eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
        AccessibilityEvent.TYPE_WINDOWS_CHANGED
      feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
      flags = flags or
        AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
        AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      notificationTimeout = 0
    }
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event == null) return
    if (
      event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
      event.eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED
    ) {
      return
    }
    val pkg = event.packageName?.toString() ?: return
    if (pkg == packageName || pkg == "com.android.systemui") return

    val locked = readLockedPackages(prefs)
    if (locked.isEmpty() || !locked.contains(pkg)) return

    val graceUntil = prefs.getLong(KEY_GRACE_UNTIL, 0L)
    if (System.currentTimeMillis() < graceUntil) return

    val now = SystemClock.elapsedRealtime()
    if (pkg == lastTriggerPkg && now - lastTriggerAt < 400L) return
    lastTriggerPkg = pkg
    lastTriggerAt = now

    interceptLockedLaunch(pkg, readPolicyFlags())
  }

  private fun interceptLockedLaunch(pkg: String, policy: PolicyFlags) {
    val started = SystemClock.elapsedRealtime()
    if (Settings.canDrawOverlays(this)) {
      mainHandler.post {
        OverlayWindowGuard.show(
          this,
          pkg,
          policy.allowDeviceCredential,
          policy.biometricStrongOnly,
          policy.postAuthGraceMs,
        )
      }
    }
    val intent = Intent(this, OverlayGuardActivity::class.java).apply {
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_NO_ANIMATION,
      )
      putExtra(OverlayGuardActivity.EXTRA_PACKAGE, pkg)
      putExtra(OverlayGuardActivity.EXTRA_ALLOW_DEVICE, policy.allowDeviceCredential)
      putExtra(OverlayGuardActivity.EXTRA_STRONG_ONLY, policy.biometricStrongOnly)
      putExtra(OverlayGuardActivity.EXTRA_GRACE_MS, policy.postAuthGraceMs)
      putExtra(OverlayGuardActivity.EXTRA_DETECT_ELAPSED_MS, SystemClock.elapsedRealtime() - started)
    }
    startActivity(intent)
  }

  override fun onInterrupt() {}

  override fun onDestroy() {
    instance = null
    OverlayWindowGuard.dismiss(this)
    super.onDestroy()
  }

  private fun readPolicyFlags(): PolicyFlags {
    val raw = prefs.getString(KEY_POLICY, null) ?: return PolicyFlags()
    return try {
      val o = JSONObject(raw)
      PolicyFlags(
        allowDeviceCredential = o.optBoolean("allowDeviceCredential", false),
        biometricStrongOnly = o.optBoolean("biometricStrongOnly", true),
        postAuthGraceMs = o.optLong("postAuthGraceMs", 8_000L),
      )
    } catch (_: Exception) {
      PolicyFlags()
    }
  }

  data class PolicyFlags(
    val allowDeviceCredential: Boolean = false,
    val biometricStrongOnly: Boolean = true,
    val postAuthGraceMs: Long = 8_000L,
  )
}
