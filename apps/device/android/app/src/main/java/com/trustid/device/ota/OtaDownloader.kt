package com.trustid.device.ota

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class OtaHttpResponse(
  val status: Int,
  val contentType: String?,
  val contentLength: Long,
  val body: InputStream,
  private val onClose: () -> Unit = {},
) : Closeable {
  override fun close() {
    try {
      body.close()
    } catch (_: IOException) {
    }
    onClose()
  }
}

fun interface OtaHttp {
  @Throws(IOException::class)
  fun get(url: String, headers: Map<String, String>): OtaHttpResponse
}

/** HTTPS only, bounded timeouts, no redirects (a redirect could leave the pinned host). */
class UrlConnectionOtaHttp(
  private val connectTimeoutMs: Int = 10_000,
  private val readTimeoutMs: Int = 30_000,
) : OtaHttp {
  override fun get(url: String, headers: Map<String, String>): OtaHttpResponse {
    val target = URL(url)
    if (target.protocol != "https") {
      throw OtaException(OtaFailure.MANIFEST_UNTRUSTED_URL, "OTA requests must use https")
    }
    val conn = target.openConnection() as HttpURLConnection
    conn.connectTimeout = connectTimeoutMs
    conn.readTimeout = readTimeoutMs
    conn.instanceFollowRedirects = false
    conn.useCaches = false
    for ((k, v) in headers) conn.setRequestProperty(k, v)
    val status = conn.responseCode
    val stream =
      if (status in 200..299) conn.inputStream else conn.errorStream ?: ByteArrayInputStream(ByteArray(0))
    val length = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
    return OtaHttpResponse(status, conn.contentType, length, stream) { conn.disconnect() }
  }
}

object OtaFiles {
  const val DIR_NAME = "trustid-ota"
  private val NAME = Regex("^TrustID-(\\d+)\\.apk(\\.part)?$")

  fun apkFileName(versionCode: Long) = "TrustID-$versionCode.apk"

  /**
   * Deletes only TrustID OTA files in the private OTA directory: partial downloads,
   * versions already installed (or older), and anything other than [keepVersionCode].
   */
  fun cleanStale(dir: File, installedVersionCode: Long, keepVersionCode: Long? = null): List<String> {
    val removed = mutableListOf<String>()
    val files = dir.listFiles() ?: return removed
    for (file in files) {
      val match = NAME.matchEntire(file.name) ?: continue
      val versionCode = match.groupValues[1].toLongOrNull() ?: continue
      val partial = match.groupValues[2].isNotEmpty()
      val stale =
        partial ||
          versionCode <= installedVersionCode ||
          (keepVersionCode != null && versionCode != keepVersionCode)
      if (stale && file.isFile && file.delete()) removed.add(file.name)
    }
    return removed
  }
}

class OtaDownloader(
  private val http: OtaHttp,
  private val maxAttempts: Int = 3,
  private val backoffMs: (attempt: Int) -> Long = { attempt -> 2_000L * attempt },
  private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
) {
  fun fetchManifest(url: String, trustedHost: String): OtaManifest =
    retrying { fetchManifestOnce(url, trustedHost) }

  fun downloadApk(manifest: OtaManifest, dir: File, cancelled: () -> Boolean = { false }): File {
    if (!dir.isDirectory && !dir.mkdirs()) {
      throw OtaException(OtaFailure.STORAGE, "cannot create OTA cache directory")
    }
    val target = File(dir, OtaFiles.apkFileName(manifest.versionCode))
    if (target.isFile) {
      try {
        OtaVerifier.verifyFile(target, manifest)
        return target
      } catch (_: OtaException) {
        target.delete()
      }
    }
    return retrying { downloadOnce(manifest, dir, target, cancelled) }
  }

  private fun fetchManifestOnce(url: String, trustedHost: String): OtaManifest {
    val headers = mapOf("Accept" to "application/json", "Cache-Control" to "no-cache")
    return open(url, headers).use { response ->
      when {
        response.status >= 500 -> throw OtaException(OtaFailure.SERVER_ERROR, "manifest HTTP ${response.status}")
        response.status != 200 -> throw OtaException(OtaFailure.MANIFEST_HTTP, "manifest HTTP ${response.status}")
      }
      val contentType = response.contentType?.lowercase() ?: ""
      if (!contentType.contains("json")) {
        throw OtaException(OtaFailure.MANIFEST_NOT_JSON, "manifest content-type is not JSON")
      }
      if (response.contentLength > OtaManifestParser.MAX_MANIFEST_BYTES) {
        throw OtaException(OtaFailure.MANIFEST_TOO_LARGE, "manifest too large")
      }
      val bytes = readCapped(response.body, OtaManifestParser.MAX_MANIFEST_BYTES)
      OtaManifestParser.parse(String(bytes, Charsets.UTF_8), trustedHost)
    }
  }

  private fun downloadOnce(
    manifest: OtaManifest,
    dir: File,
    target: File,
    cancelled: () -> Boolean,
  ): File {
    val part = File(dir, "${target.name}.part")
    part.delete()
    try {
      open(manifest.apkUrl, mapOf("Accept-Encoding" to "identity")).use { response ->
        when {
          response.status >= 500 -> throw OtaException(OtaFailure.SERVER_ERROR, "APK HTTP ${response.status}")
          response.status != 200 -> throw OtaException(OtaFailure.DOWNLOAD_HTTP, "APK HTTP ${response.status}")
        }
        if (response.contentType?.lowercase()?.contains("text/html") == true) {
          throw OtaException(OtaFailure.NOT_AN_APK, "APK URL returned HTML")
        }
        if (response.contentLength >= 0 && response.contentLength != manifest.apkSize) {
          throw OtaException(OtaFailure.DOWNLOAD_SIZE_MISMATCH, "APK Content-Length differs from manifest")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        val out =
          try {
            FileOutputStream(part)
          } catch (e: IOException) {
            throw OtaException(OtaFailure.STORAGE, "cannot write OTA file", e)
          }
        out.use {
          val buffer = ByteArray(64 * 1024)
          while (true) {
            if (cancelled()) throw OtaException(OtaFailure.CANCELLED, "download cancelled")
            val read =
              try {
                response.body.read(buffer)
              } catch (e: IOException) {
                throw OtaException(OtaFailure.DOWNLOAD_INTERRUPTED, "download interrupted", e)
              }
            if (read < 0) break
            total += read
            if (total > manifest.apkSize) {
              throw OtaException(OtaFailure.DOWNLOAD_TOO_LARGE, "APK larger than manifest")
            }
            digest.update(buffer, 0, read)
            try {
              it.write(buffer, 0, read)
            } catch (e: IOException) {
              throw OtaException(OtaFailure.STORAGE, "disk write failed", e)
            }
          }
          try {
            it.fd.sync()
          } catch (e: IOException) {
            throw OtaException(OtaFailure.STORAGE, "disk sync failed", e)
          }
        }
        if (total != manifest.apkSize) {
          throw OtaException(OtaFailure.DOWNLOAD_INTERRUPTED, "download ended early")
        }
        if (digest.digest().toHex() != manifest.apkSha256) {
          throw OtaException(OtaFailure.HASH_MISMATCH, "APK SHA-256 does not match manifest")
        }
        if (!OtaVerifier.isZip(part)) throw OtaException(OtaFailure.NOT_AN_APK, "download is not an APK")
        target.delete()
        if (!part.renameTo(target)) throw OtaException(OtaFailure.STORAGE, "cannot finalize OTA file")
        return target
      }
    } catch (e: Throwable) {
      part.delete()
      throw e
    }
  }

  private fun open(url: String, headers: Map<String, String>): OtaHttpResponse =
    try {
      http.get(url, headers)
    } catch (e: OtaException) {
      throw e
    } catch (e: IOException) {
      throw OtaException(OtaFailure.NETWORK, "network unavailable", e)
    }

  private fun readCapped(input: InputStream, cap: Int): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    try {
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        if (out.size() + read > cap) throw OtaException(OtaFailure.MANIFEST_TOO_LARGE, "manifest too large")
        out.write(buffer, 0, read)
      }
    } catch (e: IOException) {
      throw OtaException(OtaFailure.NETWORK, "manifest read failed", e)
    }
    return out.toByteArray()
  }

  private fun <T> retrying(block: () -> T): T {
    var attempt = 1
    while (true) {
      try {
        return block()
      } catch (e: OtaException) {
        if (!e.failure.retryable || attempt >= maxAttempts) throw e
        sleeper(backoffMs(attempt))
        attempt++
      }
    }
  }
}
