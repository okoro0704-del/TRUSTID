package com.trustid.device.ota

import com.trustid.device.ota.OtaTestFixtures.APK_BYTES
import com.trustid.device.ota.OtaTestFixtures.HOST
import com.trustid.device.ota.OtaTestFixtures.manifest
import com.trustid.device.ota.OtaTestFixtures.manifestJson
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException

class OtaDownloaderTest {
  @get:Rule val tmp = TemporaryFolder()

  private val manifestUrl = "https://$HOST/releases/trustid-android.json"

  private class ScriptedHttp(private val responses: MutableList<() -> OtaHttpResponse>) : OtaHttp {
    var calls = 0
    val ranges = mutableListOf<String?>()
    override fun get(url: String, headers: Map<String, String>): OtaHttpResponse {
      calls++
      ranges.add(headers["Range"])
      if (responses.isEmpty()) throw IOException("no scripted response")
      return responses.removeAt(0).invoke()
    }
  }

  /** Honors `Range: bytes=N-` and drops the connection after [chunk] bytes per request. */
  private class FlakyRangeServer(private val bytes: ByteArray, private val chunk: Int) : OtaHttp {
    val ranges = mutableListOf<String?>()
    override fun get(url: String, headers: Map<String, String>): OtaHttpResponse {
      val range = headers["Range"]
      ranges.add(range)
      val start = range?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
      val end = minOf(bytes.size, start + chunk)
      val stream =
        object : InputStream() {
          var pos = start
          override fun read(): Int {
            if (pos >= end) {
              if (end < bytes.size) throw SocketTimeoutException("connection dropped")
              return -1
            }
            return bytes[pos++].toInt() and 0xff
          }
        }
      val status = if (range != null) 206 else 200
      val contentRange = if (range != null) "bytes $start-${bytes.size - 1}/${bytes.size}" else null
      return OtaHttpResponse(
        status,
        "application/vnd.android.package-archive",
        (bytes.size - start).toLong(),
        stream,
        contentRange,
      )
    }
  }

  private fun partialOk(body: ByteArray, from: Int, contentRange: String) = {
    OtaHttpResponse(
      206,
      "application/vnd.android.package-archive",
      (body.size - from).toLong(),
      ByteArrayInputStream(body, from, body.size - from),
      contentRange,
    )
  }

  private fun ok(body: ByteArray, contentType: String, length: Long = body.size.toLong()) = {
    OtaHttpResponse(200, contentType, length, ByteArrayInputStream(body))
  }

  private fun status(code: Int) = { OtaHttpResponse(code, "text/plain", 0, ByteArrayInputStream(ByteArray(0))) }

  /** Delivers [cutAfter] bytes and then fails like a dropped connection. */
  private fun interrupted(body: ByteArray, cutAfter: Int) = {
    val stream =
      object : InputStream() {
        var pos = 0
        override fun read(): Int {
          if (pos >= cutAfter) throw SocketTimeoutException("read timed out")
          return body[pos++].toInt() and 0xff
        }
      }
    OtaHttpResponse(200, "application/vnd.android.package-archive", body.size.toLong(), stream)
  }

  private fun downloader(http: OtaHttp, sleeps: MutableList<Long> = mutableListOf()) =
    OtaDownloader(http, maxAttempts = 3, backoffMs = { it * 10L }, sleeper = { sleeps.add(it) })

  private fun expect(expected: OtaFailure, block: () -> Unit) {
    try {
      block()
      fail("expected $expected")
    } catch (e: OtaException) {
      assertEquals(expected, e.failure)
    }
  }

  private fun otaDir(): File = File(tmp.root, OtaFiles.DIR_NAME)

  @Test
  fun fetchesValidManifest() {
    val http = ScriptedHttp(mutableListOf(ok(manifestJson().toString().toByteArray(), "application/json")))
    assertEquals(2L, downloader(http).fetchManifest(manifestUrl, HOST).versionCode)
  }

  @Test
  fun manifestOfflineRetriesThenFails() {
    val sleeps = mutableListOf<Long>()
    val http = ScriptedHttp(mutableListOf())
    expect(OtaFailure.NETWORK) { downloader(http, sleeps).fetchManifest(manifestUrl, HOST) }
    assertEquals(3, http.calls)
    assertEquals(listOf(10L, 20L), sleeps)
  }

  @Test
  fun manifestTimeoutIsRetriedAndRecovers() {
    val http =
      ScriptedHttp(
        mutableListOf(
          { throw SocketTimeoutException("connect timed out") },
          ok(manifestJson().toString().toByteArray(), "application/json"),
        ),
      )
    assertEquals(2L, downloader(http).fetchManifest(manifestUrl, HOST).versionCode)
    assertEquals(2, http.calls)
  }

  @Test
  fun htmlFallbackWith200IsRejectedWithoutRetry() {
    val http = ScriptedHttp(mutableListOf(ok("<!doctype html>".toByteArray(), "text/html; charset=UTF-8")))
    expect(OtaFailure.MANIFEST_NOT_JSON) { downloader(http).fetchManifest(manifestUrl, HOST) }
    assertEquals(1, http.calls)
  }

  @Test
  fun manifest404IsNotRetried() {
    val http = ScriptedHttp(mutableListOf(status(404)))
    expect(OtaFailure.MANIFEST_HTTP) { downloader(http).fetchManifest(manifestUrl, HOST) }
    assertEquals(1, http.calls)
  }

  @Test
  fun oversizedManifestIsRejected() {
    val big = ByteArray(OtaManifestParser.MAX_MANIFEST_BYTES + 1) { ' '.code.toByte() }
    val http = ScriptedHttp(mutableListOf(ok(big, "application/json", length = -1)))
    expect(OtaFailure.MANIFEST_TOO_LARGE) { downloader(http).fetchManifest(manifestUrl, HOST) }
  }

  @Test
  fun downloadsAndVerifiesApk() {
    val http = ScriptedHttp(mutableListOf(ok(APK_BYTES, "application/vnd.android.package-archive")))
    val file = downloader(http).downloadApk(manifest(), otaDir())
    assertEquals("TrustID-2.apk", file.name)
    assertArrayEquals(APK_BYTES, file.readBytes())
    assertFalse(File(otaDir(), "TrustID-2.apk.part").exists())
  }

  @Test
  fun interruptedDownloadResumesWithRangeAndServerIgnoringRangeRestartsCleanly() {
    val http =
      ScriptedHttp(
        mutableListOf(
          interrupted(APK_BYTES, cutAfter = 1000),
          ok(APK_BYTES, "application/vnd.android.package-archive"),
        ),
      )
    val file = downloader(http).downloadApk(manifest(), otaDir())
    assertEquals(listOf(null, "bytes=1000-"), http.ranges)
    assertArrayEquals(APK_BYTES, file.readBytes())
    assertEquals(listOf("TrustID-2.apk"), otaDir().list()!!.toList())
  }

  @Test
  fun flakyNetworkCompletesByResumingManyTimes() {
    val server = FlakyRangeServer(APK_BYTES, chunk = 500)
    val file = downloader(server).downloadApk(manifest(), otaDir())
    assertArrayEquals(APK_BYTES, file.readBytes())
    assertEquals(null, server.ranges.first())
    assertEquals("bytes=500-", server.ranges[1])
    assertTrue(server.ranges.size > 3)
    assertEquals(listOf("TrustID-2.apk"), otaDir().list()!!.toList())
  }

  @Test
  fun partialDownloadSurvivesForTheNextCheck() {
    val first = FlakyRangeServer(APK_BYTES, chunk = 1500)
    val oneShot = OtaDownloader(first, maxAttempts = 1, sleeper = {}, maxResumes = 1)
    expect(OtaFailure.DOWNLOAD_INTERRUPTED) { oneShot.downloadApk(manifest(), otaDir()) }
    assertEquals(1500L, File(otaDir(), "TrustID-2.apk.part").length())

    val second = FlakyRangeServer(APK_BYTES, chunk = APK_BYTES.size)
    val file = downloader(second).downloadApk(manifest(), otaDir())
    assertEquals(listOf("bytes=1500-"), second.ranges)
    assertArrayEquals(APK_BYTES, file.readBytes())
  }

  @Test
  fun stalledDownloadGivesUpAfterBoundedAttempts() {
    val server = FlakyRangeServer(APK_BYTES, chunk = 0)
    expect(OtaFailure.DOWNLOAD_INTERRUPTED) { downloader(server).downloadApk(manifest(), otaDir()) }
    assertEquals(3, server.ranges.size)
    assertFalse(File(otaDir(), "TrustID-2.apk").exists())
  }

  @Test
  fun corruptResumedPrefixIsCaughtByFullHash() {
    otaDir().mkdirs()
    File(otaDir(), "TrustID-2.apk.part").writeBytes(ByteArray(1000) { 7 })
    val server = FlakyRangeServer(APK_BYTES, chunk = APK_BYTES.size)
    expect(OtaFailure.HASH_MISMATCH) { downloader(server).downloadApk(manifest(), otaDir()) }
    assertEquals(listOf<String?>("bytes=1000-"), server.ranges)
    assertTrue(otaDir().list()!!.isEmpty())
  }

  @Test
  fun unexpectedContentRangeRestartsFromZero() {
    otaDir().mkdirs()
    File(otaDir(), "TrustID-2.apk.part").writeBytes(APK_BYTES.copyOf(1000))
    val http =
      ScriptedHttp(
        mutableListOf(
          partialOk(APK_BYTES, 0, "bytes 0-${APK_BYTES.size - 1}/${APK_BYTES.size}"),
          ok(APK_BYTES, "application/vnd.android.package-archive"),
        ),
      )
    val file = downloader(http).downloadApk(manifest(), otaDir())
    assertEquals(listOf("bytes=1000-", null), http.ranges)
    assertArrayEquals(APK_BYTES, file.readBytes())
  }

  @Test
  fun rangeNotSatisfiableRestartsFromZero() {
    otaDir().mkdirs()
    File(otaDir(), "TrustID-2.apk.part").writeBytes(APK_BYTES.copyOf(1000))
    val http = ScriptedHttp(mutableListOf(status(416), ok(APK_BYTES, "application/vnd.android.package-archive")))
    val file = downloader(http).downloadApk(manifest(), otaDir())
    assertEquals(listOf("bytes=1000-", null), http.ranges)
    assertArrayEquals(APK_BYTES, file.readBytes())
  }

  @Test
  fun wrongHashIsRejectedAndDeleted() {
    val tampered = APK_BYTES.copyOf().also { it[200] = (it[200] + 1).toByte() }
    val http = ScriptedHttp(mutableListOf(ok(tampered, "application/vnd.android.package-archive")))
    expect(OtaFailure.HASH_MISMATCH) { downloader(http).downloadApk(manifest(), otaDir()) }
    assertEquals(1, http.calls)
    assertTrue(otaDir().list()!!.isEmpty())
  }

  @Test
  fun htmlInsteadOfApkIsRejected() {
    val http = ScriptedHttp(mutableListOf(ok("<!doctype html>".toByteArray(), "text/html")))
    expect(OtaFailure.NOT_AN_APK) { downloader(http).downloadApk(manifest(), otaDir()) }
  }

  @Test
  fun contentLengthMismatchIsRejected() {
    val http =
      ScriptedHttp(mutableListOf(ok(APK_BYTES, "application/vnd.android.package-archive", length = 12)))
    expect(OtaFailure.DOWNLOAD_SIZE_MISMATCH) { downloader(http).downloadApk(manifest(), otaDir()) }
  }

  @Test
  fun bodyLargerThanManifestIsRejected() {
    val http =
      ScriptedHttp(mutableListOf(ok(APK_BYTES + ByteArray(10), "application/vnd.android.package-archive", -1)))
    expect(OtaFailure.DOWNLOAD_TOO_LARGE) { downloader(http).downloadApk(manifest(), otaDir()) }
    assertTrue(otaDir().list()!!.isEmpty())
  }

  @Test
  fun serverErrorIsRetried() {
    val http = ScriptedHttp(mutableListOf(status(503), ok(APK_BYTES, "application/vnd.android.package-archive")))
    downloader(http).downloadApk(manifest(), otaDir())
    assertEquals(2, http.calls)
  }

  @Test
  fun cancellationStopsDownloadAndCleansUp() {
    val http = ScriptedHttp(mutableListOf(ok(APK_BYTES, "application/vnd.android.package-archive")))
    expect(OtaFailure.CANCELLED) { downloader(http).downloadApk(manifest(), otaDir()) { true } }
    assertTrue(otaDir().list()!!.isEmpty())
  }

  @Test
  fun alreadyVerifiedDownloadIsReusedWithoutNetwork() {
    otaDir().mkdirs()
    File(otaDir(), "TrustID-2.apk").writeBytes(APK_BYTES)
    val http = ScriptedHttp(mutableListOf())
    downloader(http).downloadApk(manifest(), otaDir())
    assertEquals(0, http.calls)
  }

  @Test
  fun corruptCachedDownloadIsReplaced() {
    otaDir().mkdirs()
    File(otaDir(), "TrustID-2.apk").writeBytes(ByteArray(APK_BYTES.size))
    val http = ScriptedHttp(mutableListOf(ok(APK_BYTES, "application/vnd.android.package-archive")))
    val file = downloader(http).downloadApk(manifest(), otaDir())
    assertArrayEquals(APK_BYTES, file.readBytes())
  }

  @Test
  fun unwritableDirectoryIsStorageFailure() {
    val blocker = tmp.newFile("not-a-dir")
    expect(OtaFailure.STORAGE) {
      downloader(ScriptedHttp(mutableListOf())).downloadApk(manifest(), File(blocker, "child"))
    }
  }
}
