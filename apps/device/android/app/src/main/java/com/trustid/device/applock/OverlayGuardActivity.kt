package com.trustid.device.applock

import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Full-screen biometric guard overlay.
 * Applies [WindowManager.LayoutParams.FLAG_SECURE] so screenshots, screen
 * recordings, and recent-app previews cannot capture vault/app-lock content.
 */
class OverlayGuardActivity : FragmentActivity() {

  companion object {
    const val EXTRA_PACKAGE = "packageId"
    const val EXTRA_ALLOW_DEVICE = "allowDevice"
    const val EXTRA_STRONG_ONLY = "strongOnly"
    const val EXTRA_GRACE_MS = "graceMs"
    const val EXTRA_DETECT_ELAPSED_MS = "detectElapsedMs"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(
      WindowManager.LayoutParams.FLAG_SECURE or
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
    )
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
    val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
    setContentView(root)
    prompt()
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    moveTaskToBack(true)
  }

  private fun prompt() {
    val allowDevice = intent.getBooleanExtra(EXTRA_ALLOW_DEVICE, false)
    val strongOnly = intent.getBooleanExtra(EXTRA_STRONG_ONLY, true)
    val graceMs = intent.getLongExtra(EXTRA_GRACE_MS, 8_000L)
    val pkg = intent.getStringExtra(EXTRA_PACKAGE) ?: "app"

    var authenticators = if (strongOnly) {
      BiometricManager.Authenticators.BIOMETRIC_STRONG
    } else {
      BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.BIOMETRIC_WEAK
    }
    if (allowDevice) {
      authenticators = authenticators or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }

    val executor = ContextCompat.getMainExecutor(this)
    val biometricPrompt = BiometricPrompt(
      this,
      executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          val type = result.authenticationType
          if (!allowDevice &&
            type == BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL
          ) {
            deny()
            return
          }
          getSharedPreferences(AppLockService.PREFS, MODE_PRIVATE)
            .edit()
            .putLong(
              AppLockService.KEY_GRACE_UNTIL,
              System.currentTimeMillis() + graceMs,
            )
            .apply()
          OverlayWindowGuard.dismissIfPresent(this@OverlayGuardActivity)
          finish()
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          deny()
        }
      },
    )

    val builder = BiometricPrompt.PromptInfo.Builder()
      .setTitle("TrustID App Lock")
      .setSubtitle("Unlock $pkg")
      .setAllowedAuthenticators(authenticators)
    if (!allowDevice) builder.setNegativeButtonText("Cancel")

    biometricPrompt.authenticate(builder.build())
  }

  private fun deny() {
    OverlayWindowGuard.dismissIfPresent(this)
    moveTaskToBack(true)
    finish()
  }
}
