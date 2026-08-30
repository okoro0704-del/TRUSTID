package com.trustid.device.applock

import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout

/**
 * Instant SYSTEM_ALERT_WINDOW blackout drawn within the accessibility callback
 * path so locked app content is obscured before [OverlayGuardActivity] resumes.
 */
object OverlayWindowGuard {
  private var overlayView: View? = null

  fun show(
    service: AppLockService,
    packageId: String,
    allowDevice: Boolean,
    strongOnly: Boolean,
    graceMs: Long,
  ) {
    if (!Settings.canDrawOverlays(service)) return
    dismiss(service)

    val wm = service.getSystemService(WindowManager::class.java) ?: return
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }

    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_SECURE or
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.OPAQUE,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      title = "TrustID App Lock"
    }

    val view = FrameLayout(service).apply {
      setBackgroundColor(Color.BLACK)
      contentDescription = "TrustID locked: $packageId"
      // Tap forwards to the FLAG_SECURE activity for biometric.
      isClickable = true
      setOnClickListener {
        val intent = android.content.Intent(service, OverlayGuardActivity::class.java).apply {
          addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
          putExtra(OverlayGuardActivity.EXTRA_PACKAGE, packageId)
          putExtra(OverlayGuardActivity.EXTRA_ALLOW_DEVICE, allowDevice)
          putExtra(OverlayGuardActivity.EXTRA_STRONG_ONLY, strongOnly)
          putExtra(OverlayGuardActivity.EXTRA_GRACE_MS, graceMs)
        }
        service.startActivity(intent)
      }
    }

    try {
      wm.addView(view, params)
      overlayView = view
    } catch (_: Exception) {
      overlayView = null
    }
  }

  fun dismiss(service: AppLockService) {
    val view = overlayView ?: return
    overlayView = null
    try {
      val wm = service.getSystemService(WindowManager::class.java) ?: return
      wm.removeViewImmediate(view)
    } catch (_: Exception) {
      /* already gone */
    }
  }

  fun dismissIfPresent(context: android.content.Context) {
    val svc = AppLockService.instance ?: return
    dismiss(svc)
  }
}
