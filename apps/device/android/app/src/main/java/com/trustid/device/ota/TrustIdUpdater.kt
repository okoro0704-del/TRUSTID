package com.trustid.device.ota

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.content.FileProvider
import com.trustid.device.BuildConfig
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native (APK) update channel. Runs entirely off the UI thread after the WebView has
 * started, so a missing/slow/malformed manifest can never delay or blank the shell.
 *
 * Android still owns the final install confirmation: this class only discovers,
 * downloads, verifies and hands the APK to the system package installer.
 */
object TrustIdUpdater {
  private const val TAG = "TrustIdOta"
  private const val PREFS = "trustid_ota"
  private const val APK_MIME = "application/vnd.android.package-archive"
  private const val STARTUP_DELAY_MS = 4_000L
  private const val RESUME_THROTTLE_MS = 15 * 60 * 1000L

  private val running = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private val executor =
    Executors.newSingleThreadExecutor { r ->
      Thread(r, "trustid-ota").apply {
        isDaemon = true
        priority = Thread.MIN_PRIORITY
      }
    }
  private val main = Handler(Looper.getMainLooper())

  private data class PendingInstall(val file: File, val manifest: OtaManifest)

  @Volatile private var activityRef: WeakReference<Activity>? = null
  @Volatile private var resumed = false
  @Volatile private var pending: PendingInstall? = null
  @Volatile private var lastCheckStartedAt = 0L
  private val autoHandedOff = mutableSetOf<Long>()
  private val permissionPrompted = mutableSetOf<Long>()

  @JvmStatic
  fun onCreate(activity: Activity) {
    activityRef = WeakReference(activity)
    val app = activity.applicationContext
    main.postDelayed({ schedule(app, userInitiated = false) }, STARTUP_DELAY_MS)
  }

  @JvmStatic
  fun onResume(activity: Activity) {
    activityRef = WeakReference(activity)
    resumed = true
    if (pending != null) {
      handOff(userInitiated = false)
      return
    }
    val sinceLast = System.currentTimeMillis() - lastCheckStartedAt
    if (lastCheckStartedAt != 0L && sinceLast >= RESUME_THROTTLE_MS) {
      schedule(activity.applicationContext, userInitiated = false)
    }
  }

  @JvmStatic
  fun onPause() {
    resumed = false
  }

  /** @return false when a check/download is already in flight (single-flight). */
  fun checkNow(context: Context): Boolean = schedule(context.applicationContext, userInitiated = true)

  fun status(context: Context): Map<String, Any?> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return mapOf(
      "otaCapable" to true,
      "channel" to BuildConfig.TRUSTID_RELEASE_CHANNEL,
      "manifestUrl" to BuildConfig.TRUSTID_OTA_MANIFEST_URL,
      "installedVersionCode" to BuildConfig.VERSION_CODE,
      "installedVersionName" to BuildConfig.VERSION_NAME,
      "running" to running.get(),
      "lastStatus" to prefs.getString("last_status", "idle"),
      "lastFailure" to prefs.getString("last_failure", null),
      "lastCheckAt" to prefs.getLong("last_check_at", 0L),
      "availableVersionCode" to prefs.getLong("available_version_code", 0L),
      "canRequestPackageInstalls" to canRequestInstalls(context),
    )
  }

  private fun schedule(app: Context, userInitiated: Boolean): Boolean {
    if (!running.compareAndSet(false, true)) return false
    lastCheckStartedAt = System.currentTimeMillis()
    cancelled.set(false)
    executor.execute {
      try {
        runCheck(app, userInitiated)
      } catch (e: OtaException) {
        recordFailure(app, e.failure, e.message)
      } catch (e: Throwable) {
        recordFailure(app, null, e.javaClass.simpleName)
      } finally {
        running.set(false)
      }
    }
    return true
  }

  private fun runCheck(app: Context, userInitiated: Boolean) {
    val installed = installedApp(app)
    val dir = File(app.cacheDir, OtaFiles.DIR_NAME)
    OtaFiles.cleanStale(dir, installed.versionCode).forEach { Log.i(TAG, "removed stale $it") }
    record(app, "checking")

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
      throw OtaException(OtaFailure.UNSUPPORTED_ANDROID, "in-app installer handoff needs Android 7+")
    }

    val manifestUrl = BuildConfig.TRUSTID_OTA_MANIFEST_URL
    val downloader = OtaDownloader(UrlConnectionOtaHttp())
    val manifest = downloader.fetchManifest(manifestUrl, OtaManifestParser.hostOf(manifestUrl))
    if (OtaPolicy.decide(manifest, installed) == OtaDecision.UP_TO_DATE) {
      pending = null
      record(app, "up-to-date", availableVersionCode = manifest.versionCode)
      Log.i(TAG, "up to date (installed=${installed.versionCode}, published=${manifest.versionCode})")
      return
    }

    OtaFiles.cleanStale(dir, installed.versionCode, keepVersionCode = manifest.versionCode)
    record(app, "downloading", availableVersionCode = manifest.versionCode)
    Log.i(TAG, "update ${installed.versionCode} -> ${manifest.versionCode} (${manifest.releaseId})")
    toast("Downloading TrustID update ${manifest.versionName}…")

    val apk = downloader.downloadApk(manifest, dir) { cancelled.get() }
    try {
      OtaVerifier.verifyIdentity(readArchiveIdentity(app, apk), manifest, installed)
    } catch (e: OtaException) {
      apk.delete()
      throw e
    }
    pending = PendingInstall(apk, manifest)
    record(app, "verified", availableVersionCode = manifest.versionCode)
    Log.i(TAG, "verified ${apk.name} sha256=${manifest.apkSha256}")
    main.post { handOff(userInitiated) }
  }

  private fun handOff(userInitiated: Boolean) {
    val next = pending ?: return
    val activity = activityRef?.get()
    if (activity == null || !resumed || activity.isFinishing) return
    val versionCode = next.manifest.versionCode
    if (!userInitiated && autoHandedOff.contains(versionCode)) return

    if (!canRequestInstalls(activity)) {
      if (userInitiated || permissionPrompted.add(versionCode)) {
        promptInstallPermission(activity, next.manifest)
      }
      record(activity.applicationContext, "awaiting-install-permission", availableVersionCode = versionCode)
      return
    }

    val app = activity.applicationContext
    executor.execute {
      try {
        OtaVerifier.verifyFile(next.file, next.manifest)
        main.post { launchInstaller(activity, next) }
      } catch (e: OtaException) {
        next.file.delete()
        pending = null
        recordFailure(app, e.failure, e.message)
      }
    }
  }

  private fun launchInstaller(activity: Activity, next: PendingInstall) {
    val app = activity.applicationContext
    try {
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", next.file)
      val intent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, APK_MIME)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      autoHandedOff.add(next.manifest.versionCode)
      record(app, "installer-launched", availableVersionCode = next.manifest.versionCode)
      Log.i(TAG, "installer handoff for versionCode ${next.manifest.versionCode}")
    } catch (e: ActivityNotFoundException) {
      recordFailure(app, OtaFailure.INSTALLER_UNAVAILABLE, "no package installer")
    } catch (e: IllegalArgumentException) {
      recordFailure(app, OtaFailure.INSTALLER_UNAVAILABLE, "FileProvider rejected OTA path")
    }
  }

  private fun promptInstallPermission(activity: Activity, manifest: OtaManifest) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    AlertDialog.Builder(activity)
      .setTitle("TrustID update ready")
      .setMessage(
        "TrustID ${manifest.versionName} has been downloaded and verified. " +
          "Android needs your permission for TrustID to open its own updates. " +
          "Tap Allow, turn on \"Allow from this source\", then return to TrustID.",
      )
      .setPositiveButton("Allow") { _, _ ->
        try {
          activity.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
          )
        } catch (_: ActivityNotFoundException) {
          recordFailure(activity.applicationContext, OtaFailure.INSTALLER_UNAVAILABLE, "settings unavailable")
        }
      }
      .setNegativeButton("Later", null)
      .show()
  }

  private fun canRequestInstalls(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

  private fun installedApp(context: Context): InstalledApp {
    val info = packageInfo(context.packageManager, null, context.packageName)
    return InstalledApp(
      packageName = context.packageName,
      versionCode = info?.let { versionCodeOf(it) } ?: BuildConfig.VERSION_CODE.toLong(),
      sdkInt = Build.VERSION.SDK_INT,
      signerSha256 = info?.let { signersOf(it) } ?: emptySet(),
    )
  }

  private fun readArchiveIdentity(context: Context, apk: File): ArchiveIdentity? {
    val info = packageInfo(context.packageManager, apk, null) ?: return null
    return ArchiveIdentity(info.packageName ?: "", versionCodeOf(info), signersOf(info))
  }

  @SuppressLint("PackageManagerGetSignatures")
  @Suppress("DEPRECATION")
  private fun packageInfo(pm: PackageManager, archive: File?, packageName: String?): PackageInfo? {
    val flags =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
      } else {
        PackageManager.GET_SIGNATURES
      }
    return try {
      if (archive != null) pm.getPackageArchiveInfo(archive.path, flags) else pm.getPackageInfo(packageName!!, flags)
    } catch (_: PackageManager.NameNotFoundException) {
      null
    }
  }

  @Suppress("DEPRECATION")
  private fun versionCodeOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signersOf(info: PackageInfo): Set<String> {
    val signatures =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.signingInfo?.apkContentsSigners
      } else {
        info.signatures
      }
    return signatures?.map { OtaVerifier.sha256Hex(it.toByteArray()) }?.toSet() ?: emptySet()
  }

  private fun toast(message: String) {
    main.post {
      val activity = activityRef?.get()
      if (activity != null && resumed && !activity.isFinishing) {
        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
      }
    }
  }

  private fun record(context: Context, status: String, availableVersionCode: Long? = null) {
    val editor =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString("last_status", status)
        .putLong("last_check_at", System.currentTimeMillis())
        .remove("last_failure")
    if (availableVersionCode != null) editor.putLong("available_version_code", availableVersionCode)
    editor.apply()
  }

  private fun recordFailure(context: Context, failure: OtaFailure?, message: String?) {
    val code = failure?.name ?: "UNEXPECTED"
    Log.w(TAG, "OTA failed: $code ${message ?: ""}")
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString("last_status", "failed")
      .putString("last_failure", code)
      .putLong("last_check_at", System.currentTimeMillis())
      .apply()
  }
}
