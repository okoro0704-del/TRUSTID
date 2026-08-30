package com.trustid.device.applock

/**
 * Back-compat activity name used by older plugin code paths.
 * Delegates entirely to [OverlayGuardActivity].
 */
class AppLockOverlayActivity : OverlayGuardActivity() {
  companion object {
    const val EXTRA_PACKAGE = OverlayGuardActivity.EXTRA_PACKAGE
    const val EXTRA_ALLOW_DEVICE = OverlayGuardActivity.EXTRA_ALLOW_DEVICE
    const val EXTRA_STRONG_ONLY = OverlayGuardActivity.EXTRA_STRONG_ONLY
    const val EXTRA_GRACE_MS = OverlayGuardActivity.EXTRA_GRACE_MS
  }
}
