package com.trustid.device.ota

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

data class InstalledApp(
  val packageName: String,
  val versionCode: Long,
  val sdkInt: Int,
  val signerSha256: Set<String>,
)

data class ArchiveIdentity(
  val packageName: String,
  val versionCode: Long,
  val signerSha256: Set<String>,
)

enum class OtaDecision { UP_TO_DATE, UPDATE_AVAILABLE }

object OtaPolicy {
  /** Native updates are decided by versionCode only; versionName is display text. */
  fun decide(manifest: OtaManifest, installed: InstalledApp): OtaDecision {
    if (manifest.applicationId != installed.packageName) {
      throw OtaException(OtaFailure.WRONG_PACKAGE, "manifest is for another application")
    }
    if (manifest.versionCode <= installed.versionCode) return OtaDecision.UP_TO_DATE
    if (installed.sdkInt < manifest.minSdk) {
      throw OtaException(OtaFailure.INCOMPATIBLE_SDK, "update requires a newer Android version")
    }
    return OtaDecision.UPDATE_AVAILABLE
  }
}

object OtaVerifier {
  private val ZIP_MAGIC = byteArrayOf(0x50, 0x4b, 0x03, 0x04)

  fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

  fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().toHex()
  }

  fun isZip(file: File): Boolean {
    if (!file.isFile || file.length() < ZIP_MAGIC.size) return false
    val header = ByteArray(ZIP_MAGIC.size)
    FileInputStream(file).use { input ->
      if (input.read(header) != header.size) return false
    }
    return header.contentEquals(ZIP_MAGIC)
  }

  /** Size, APK container and SHA-256 must match the manifest exactly. */
  fun verifyFile(file: File, manifest: OtaManifest) {
    if (!file.isFile) throw OtaException(OtaFailure.STORAGE, "update file missing")
    if (file.length() != manifest.apkSize) {
      throw OtaException(OtaFailure.DOWNLOAD_SIZE_MISMATCH, "update size does not match manifest")
    }
    if (!isZip(file)) throw OtaException(OtaFailure.NOT_AN_APK, "update is not an APK archive")
    if (sha256Hex(file) != manifest.apkSha256) {
      throw OtaException(OtaFailure.HASH_MISMATCH, "update SHA-256 does not match manifest")
    }
  }

  /**
   * The downloaded archive must be this app, the exact advertised versionCode,
   * newer than what is installed, and signed by the installed app's certificate(s).
   * Missing signing information fails closed.
   */
  fun verifyIdentity(archive: ArchiveIdentity?, manifest: OtaManifest, installed: InstalledApp) {
    if (archive == null) throw OtaException(OtaFailure.ARCHIVE_UNREADABLE, "Android could not parse the update")
    if (archive.packageName != manifest.applicationId || archive.packageName != installed.packageName) {
      throw OtaException(OtaFailure.ARCHIVE_WRONG_PACKAGE, "update package name mismatch")
    }
    if (archive.versionCode != manifest.versionCode) {
      throw OtaException(OtaFailure.ARCHIVE_VERSION_MISMATCH, "update versionCode differs from manifest")
    }
    if (archive.versionCode <= installed.versionCode) {
      throw OtaException(OtaFailure.ARCHIVE_NOT_NEWER, "update is not newer than the installed app")
    }
    if (archive.signerSha256.isEmpty() || installed.signerSha256.isEmpty()) {
      throw OtaException(OtaFailure.SIGNER_UNAVAILABLE, "signing certificate unavailable")
    }
    if (archive.signerSha256 != installed.signerSha256 || archive.signerSha256 != manifest.signerSha256) {
      throw OtaException(OtaFailure.SIGNER_MISMATCH, "update signer differs from the installed app")
    }
  }
}

internal fun ByteArray.toHex(): String {
  val out = StringBuilder(size * 2)
  for (b in this) {
    val v = b.toInt() and 0xff
    out.append("0123456789abcdef"[v ushr 4])
    out.append("0123456789abcdef"[v and 0x0f])
  }
  return out.toString()
}
