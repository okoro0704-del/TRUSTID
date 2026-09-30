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
    override fun get(url: String, headers: Map<String, String>): OtaHttpResponse {
      calls++
      if (responses.isEmpty()) throw IOException("no scripted response")
      return responses.removeAt(0).invoke()
    }
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
  fun interruptedDownloadIsRetriedAndLeavesNoPartialFile() {
    val http =
      ScriptedHttp(
        mutableListOf(
          interrupted(APK_BYTES, cutAfter = 1000),
          ok(APK_BYTES, "application/vnd.android.package-archive"),
        ),
      )
    val file = downloader(http).downloadApk(manifest(), otaDir())
    assertArrayEquals(APK_BYTES, file.readBytes())
    assertEquals(listOf("TrustID-2.apk"), otaDir().list()!!.toList())
  }

  @Test
  fun persistentInterruptionFailsAndCleansUp() {
    val http = ScriptedHttp(MutableList(3) { interrupted(APK_BYTES, cutAfter = 500) })
    expect(OtaFailure.DOWNLOAD_INTERRUPTED) { downloader(http).downloadApk(manifest(), otaDir()) }
    assertTrue(otaDir().list()!!.isEmpty())
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
