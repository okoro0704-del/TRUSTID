package com.trustid.device.ota

import com.trustid.device.ota.OtaTestFixtures.OTHER_SIGNER
import com.trustid.device.ota.OtaTestFixtures.SIGNER
import com.trustid.device.ota.OtaTestFixtures.installed
import com.trustid.device.ota.OtaTestFixtures.manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OtaPolicyTest {
  @get:Rule val tmp = TemporaryFolder()

  private fun expect(expected: OtaFailure, block: () -> Unit) {
    try {
      block()
      fail("expected $expected")
    } catch (e: OtaException) {
      assertEquals(expected, e.failure)
    }
  }

  @Test
  fun sameVersionDoesNotUpdate() {
    assertEquals(OtaDecision.UP_TO_DATE, OtaPolicy.decide(manifest(versionCode = 2), installed(versionCode = 2)))
  }

  @Test
  fun olderVersionDoesNotUpdate() {
    assertEquals(OtaDecision.UP_TO_DATE, OtaPolicy.decide(manifest(versionCode = 1), installed(versionCode = 2)))
  }

  @Test
  fun newerVersionUpdates() {
    assertEquals(OtaDecision.UPDATE_AVAILABLE, OtaPolicy.decide(manifest(versionCode = 3), installed(versionCode = 2)))
  }

  @Test
  fun wrongPackageIsRejected() {
    val other = installed().copy(packageName = "com.example.other")
    expect(OtaFailure.WRONG_PACKAGE) { OtaPolicy.decide(manifest(), other) }
  }

  @Test
  fun tooOldAndroidIsRejected() {
    expect(OtaFailure.INCOMPATIBLE_SDK) { OtaPolicy.decide(manifest(), installed(sdkInt = 21)) }
  }

  @Test
  fun identityAcceptsMatchingArchive() {
    OtaVerifier.verifyIdentity(ArchiveIdentity("com.trustid.device", 2, setOf(SIGNER)), manifest(), installed())
  }

  @Test
  fun identityRejectsUnparseableArchive() {
    expect(OtaFailure.ARCHIVE_UNREADABLE) { OtaVerifier.verifyIdentity(null, manifest(), installed()) }
  }

  @Test
  fun identityRejectsWrongPackage() {
    expect(OtaFailure.ARCHIVE_WRONG_PACKAGE) {
      OtaVerifier.verifyIdentity(ArchiveIdentity("com.evil", 2, setOf(SIGNER)), manifest(), installed())
    }
  }

  @Test
  fun identityRejectsVersionDifferentFromManifest() {
    expect(OtaFailure.ARCHIVE_VERSION_MISMATCH) {
      OtaVerifier.verifyIdentity(ArchiveIdentity("com.trustid.device", 3, setOf(SIGNER)), manifest(), installed())
    }
  }

  @Test
  fun identityRejectsDowngrade() {
    expect(OtaFailure.ARCHIVE_NOT_NEWER) {
      OtaVerifier.verifyIdentity(
        ArchiveIdentity("com.trustid.device", 2, setOf(SIGNER)),
        manifest(versionCode = 2),
        installed(versionCode = 2),
      )
    }
  }

  @Test
  fun identityRejectsWrongSigner() {
    expect(OtaFailure.SIGNER_MISMATCH) {
      OtaVerifier.verifyIdentity(ArchiveIdentity("com.trustid.device", 2, setOf(OTHER_SIGNER)), manifest(), installed())
    }
  }

  @Test
  fun identityRejectsSignerDifferentFromInstalledEvenIfManifestAgrees() {
    expect(OtaFailure.SIGNER_MISMATCH) {
      OtaVerifier.verifyIdentity(
        ArchiveIdentity("com.trustid.device", 2, setOf(SIGNER)),
        manifest(),
        installed(signer = OTHER_SIGNER),
      )
    }
  }

  @Test
  fun identityFailsClosedWithoutSigningInfo() {
    expect(OtaFailure.SIGNER_UNAVAILABLE) {
      OtaVerifier.verifyIdentity(ArchiveIdentity("com.trustid.device", 2, emptySet()), manifest(), installed())
    }
  }

  @Test
  fun verifyFileRejectsWrongHash() {
    val file = tmp.newFile("TrustID-2.apk")
    val tampered = OtaTestFixtures.APK_BYTES.copyOf().also { it[100] = (it[100] + 1).toByte() }
    file.writeBytes(tampered)
    expect(OtaFailure.HASH_MISMATCH) { OtaVerifier.verifyFile(file, manifest()) }
  }

  @Test
  fun verifyFileRejectsNonApk() {
    val html = "<!doctype html>".toByteArray() + ByteArray(100)
    val file = tmp.newFile("TrustID-2.apk").apply { writeBytes(html) }
    expect(OtaFailure.NOT_AN_APK) { OtaVerifier.verifyFile(file, manifest(bytes = html)) }
  }

  @Test
  fun verifyFileRejectsWrongSize() {
    val file = tmp.newFile("TrustID-2.apk").apply { writeBytes(OtaTestFixtures.APK_BYTES + byteArrayOf(1)) }
    expect(OtaFailure.DOWNLOAD_SIZE_MISMATCH) { OtaVerifier.verifyFile(file, manifest()) }
  }
}
