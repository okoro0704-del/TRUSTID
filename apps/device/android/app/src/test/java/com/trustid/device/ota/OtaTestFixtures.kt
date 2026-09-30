package com.trustid.device.ota

import org.json.JSONObject

object OtaTestFixtures {
  const val HOST = "trustedid.netlify.app"
  const val SIGNER = "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa"
  const val OTHER_SIGNER = "0000000000000000000000000000000000000000000000000000000000000001"

  /** Minimal ZIP-prefixed payload standing in for an APK. */
  val APK_BYTES: ByteArray = byteArrayOf(0x50, 0x4b, 0x03, 0x04) + ByteArray(4096) { (it % 251).toByte() }

  fun manifestJson(
    versionCode: Long = 2,
    bytes: ByteArray = APK_BYTES,
    edit: JSONObject.() -> Unit = {},
  ): JSONObject =
    JSONObject()
      .put("schema", OTA_SCHEMA)
      .put("applicationId", "com.trustid.device")
      .put("channel", "development-debug")
      .put("releaseId", "trustid-android-1.1-$versionCode")
      .put("versionName", "1.1")
      .put("versionCode", versionCode)
      .put("publishedAt", "2026-09-30T00:00:00.000Z")
      .put("apkUrl", "https://$HOST/releases/TrustID.apk")
      .put("apkSha256", OtaVerifier.sha256Hex(bytes))
      .put("apkSize", bytes.size.toLong())
      .put("signerSha256", SIGNER)
      .put("minSdk", 22)
      .apply(edit)

  fun manifest(versionCode: Long = 2, bytes: ByteArray = APK_BYTES): OtaManifest =
    OtaManifestParser.parse(manifestJson(versionCode, bytes).toString(), HOST)

  fun installed(versionCode: Long = 1, signer: String = SIGNER, sdkInt: Int = 34) =
    InstalledApp("com.trustid.device", versionCode, sdkInt, setOf(signer))
}
