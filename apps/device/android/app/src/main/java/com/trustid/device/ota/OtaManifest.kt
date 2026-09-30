package com.trustid.device.ota

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

const val OTA_SCHEMA = "trustid.android-ota.v1"

/**
 * Published at /releases/trustid-android.json. The manifest itself is only trusted
 * over HTTPS from the pinned host; the APK it points to is additionally bound by
 * SHA-256, package name, versionCode and the installed app's signing certificate.
 */
data class OtaManifest(
  val applicationId: String,
  val channel: String,
  val releaseId: String,
  val versionName: String,
  val versionCode: Long,
  val publishedAt: String,
  val apkUrl: String,
  val apkSha256: String,
  val apkSize: Long,
  val signerSha256: Set<String>,
  val minSdk: Int,
)

enum class OtaFailure(val retryable: Boolean = false) {
  NETWORK(retryable = true),
  SERVER_ERROR(retryable = true),
  DOWNLOAD_INTERRUPTED(retryable = true),
  MANIFEST_HTTP,
  MANIFEST_NOT_JSON,
  MANIFEST_TOO_LARGE,
  MANIFEST_MALFORMED,
  MANIFEST_UNTRUSTED_URL,
  WRONG_PACKAGE,
  INCOMPATIBLE_SDK,
  DOWNLOAD_HTTP,
  DOWNLOAD_SIZE_MISMATCH,
  DOWNLOAD_TOO_LARGE,
  HASH_MISMATCH,
  NOT_AN_APK,
  ARCHIVE_UNREADABLE,
  ARCHIVE_WRONG_PACKAGE,
  ARCHIVE_VERSION_MISMATCH,
  ARCHIVE_NOT_NEWER,
  SIGNER_UNAVAILABLE,
  SIGNER_MISMATCH,
  STORAGE,
  CANCELLED,
  INSTALLER_UNAVAILABLE,
  UNSUPPORTED_ANDROID,
}

class OtaException(
  val failure: OtaFailure,
  message: String,
  cause: Throwable? = null,
) : Exception(message, cause)

object OtaManifestParser {
  const val MAX_MANIFEST_BYTES = 64 * 1024
  const val MAX_APK_BYTES = 256L * 1024 * 1024
  private val HEX64 = Regex("^[0-9a-f]{64}$")

  fun hostOf(url: String): String =
    try {
      URI(url).host?.lowercase(Locale.ROOT) ?: ""
    } catch (_: URISyntaxException) {
      ""
    }

  fun parse(body: String, trustedHost: String): OtaManifest {
    val trimmed = body.trimStart()
    if (!trimmed.startsWith("{")) {
      throw OtaException(OtaFailure.MANIFEST_NOT_JSON, "manifest body is not a JSON object")
    }
    val json =
      try {
        JSONObject(trimmed)
      } catch (e: JSONException) {
        throw OtaException(OtaFailure.MANIFEST_MALFORMED, "manifest JSON is malformed", e)
      }

    val schema = requireString(json, "schema")
    if (schema != OTA_SCHEMA) {
      throw OtaException(OtaFailure.MANIFEST_MALFORMED, "unsupported manifest schema")
    }
    val apkUrl = requireString(json, "apkUrl")
    requireTrustedUrl(apkUrl, trustedHost)

    val apkSize = requireLong(json, "apkSize")
    if (apkSize <= 0 || apkSize > MAX_APK_BYTES) {
      throw OtaException(OtaFailure.MANIFEST_MALFORMED, "apkSize out of range")
    }
    val versionCode = requireLong(json, "versionCode")
    if (versionCode <= 0 || versionCode > Int.MAX_VALUE) {
      throw OtaException(OtaFailure.MANIFEST_MALFORMED, "versionCode out of range")
    }
    val minSdk = if (json.has("minSdk")) requireLong(json, "minSdk").toInt() else 1

    return OtaManifest(
      applicationId = requireString(json, "applicationId"),
      channel = requireString(json, "channel"),
      releaseId = requireString(json, "releaseId"),
      versionName = requireString(json, "versionName"),
      versionCode = versionCode,
      publishedAt = requireString(json, "publishedAt"),
      apkUrl = apkUrl,
      apkSha256 = requireHex64(requireString(json, "apkSha256"), "apkSha256"),
      apkSize = apkSize,
      signerSha256 = requireSigners(json),
      minSdk = minSdk,
    )
  }

  private fun requireTrustedUrl(url: String, trustedHost: String) {
    val uri =
      try {
        URI(url)
      } catch (e: URISyntaxException) {
        throw OtaException(OtaFailure.MANIFEST_UNTRUSTED_URL, "apkUrl is not a valid URI", e)
      }
    val host = uri.host?.lowercase(Locale.ROOT)
    if (
      uri.scheme?.lowercase(Locale.ROOT) != "https" ||
      host.isNullOrEmpty() ||
      host != trustedHost.lowercase(Locale.ROOT) ||
      uri.rawUserInfo != null ||
      uri.path.isNullOrEmpty()
    ) {
      throw OtaException(OtaFailure.MANIFEST_UNTRUSTED_URL, "apkUrl must be https on the manifest host")
    }
  }

  private fun requireString(json: JSONObject, key: String): String {
    val value = json.opt(key)
    if (value !is String || value.isBlank()) {
      throw OtaException(OtaFailure.MANIFEST_MALFORMED, "missing or invalid $key")
    }
    return value
  }

  private fun requireLong(json: JSONObject, key: String): Long {
    return when (val value = json.opt(key)) {
      is Int -> value.toLong()
      is Long -> value
      else -> throw OtaException(OtaFailure.MANIFEST_MALFORMED, "missing or non-integer $key")
    }
  }

  private fun requireHex64(value: String, key: String): String {
    val normalized = value.lowercase(Locale.ROOT)
    if (!HEX64.matches(normalized)) {
      throw OtaException(OtaFailure.MANIFEST_MALFORMED, "$key must be 64 hex characters")
    }
    return normalized
  }

  private fun requireSigners(json: JSONObject): Set<String> {
    val raw = json.opt("signerSha256")
    val values =
      when (raw) {
        is String -> listOf(raw)
        is JSONArray -> (0 until raw.length()).map { raw.opt(it) as? String ?: "" }
        else -> emptyList()
      }
    if (values.isEmpty()) {
      throw OtaException(OtaFailure.MANIFEST_MALFORMED, "missing signerSha256")
    }
    return values.map { requireHex64(it, "signerSha256") }.toSet()
  }
}
