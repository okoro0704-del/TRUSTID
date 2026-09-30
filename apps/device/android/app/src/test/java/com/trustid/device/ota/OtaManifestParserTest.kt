package com.trustid.device.ota

import com.trustid.device.ota.OtaTestFixtures.HOST
import com.trustid.device.ota.OtaTestFixtures.manifestJson
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class OtaManifestParserTest {
  private fun expectFailure(expected: OtaFailure, body: String, host: String = HOST) {
    try {
      OtaManifestParser.parse(body, host)
      fail("expected $expected")
    } catch (e: OtaException) {
      assertEquals(expected, e.failure)
    }
  }

  @Test
  fun parsesValidManifest() {
    val m = OtaManifestParser.parse(manifestJson().toString(), HOST)
    assertEquals("com.trustid.device", m.applicationId)
    assertEquals(2L, m.versionCode)
    assertEquals(setOf(OtaTestFixtures.SIGNER), m.signerSha256)
    assertEquals(22, m.minSdk)
  }

  @Test
  fun acceptsSignerArrayAndUppercaseHex() {
    val body = manifestJson {
      put("signerSha256", JSONArray().put(OtaTestFixtures.SIGNER.uppercase()))
    }.toString()
    assertEquals(setOf(OtaTestFixtures.SIGNER), OtaManifestParser.parse(body, HOST).signerSha256)
  }

  @Test
  fun rejectsSpaFallbackHtml() = expectFailure(OtaFailure.MANIFEST_NOT_JSON, "<!doctype html><html></html>")

  @Test
  fun rejectsTruncatedJson() = expectFailure(OtaFailure.MANIFEST_MALFORMED, "{\"schema\": \"trustid.android-ota.v1\"")

  @Test
  fun rejectsUnknownSchema() =
    expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { put("schema", "other.v9") }.toString())

  @Test
  fun rejectsMissingHash() =
    expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { remove("apkSha256") }.toString())

  @Test
  fun rejectsShortHash() =
    expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { put("apkSha256", "abc123") }.toString())

  @Test
  fun rejectsStringVersionCode() =
    expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { put("versionCode", "3") }.toString())

  @Test
  fun rejectsFractionalVersionCode() =
    expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { put("versionCode", 2.5) }.toString())

  @Test
  fun rejectsZeroSize() = expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { put("apkSize", 0) }.toString())

  @Test
  fun rejectsMissingSigner() =
    expectFailure(OtaFailure.MANIFEST_MALFORMED, manifestJson { remove("signerSha256") }.toString())

  @Test
  fun rejectsHttpApkUrl() =
    expectFailure(
      OtaFailure.MANIFEST_UNTRUSTED_URL,
      manifestJson { put("apkUrl", "http://$HOST/releases/TrustID.apk") }.toString(),
    )

  @Test
  fun rejectsApkOnAnotherHost() =
    expectFailure(
      OtaFailure.MANIFEST_UNTRUSTED_URL,
      manifestJson { put("apkUrl", "https://evil.example/TrustID.apk") }.toString(),
    )

  @Test
  fun rejectsUserInfoHostConfusion() =
    expectFailure(
      OtaFailure.MANIFEST_UNTRUSTED_URL,
      manifestJson { put("apkUrl", "https://$HOST@evil.example/TrustID.apk") }.toString(),
    )

  @Test
  fun hostOfNormalizesCase() {
    assertEquals(HOST, OtaManifestParser.hostOf("https://TrustedID.Netlify.app/releases/trustid-android.json"))
  }
}
