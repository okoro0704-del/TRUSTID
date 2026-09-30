package com.trustid.device.ota

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class OtaFilesTest {
  @get:Rule val tmp = TemporaryFolder()

  private fun names(dir: File) = dir.list()!!.sorted()

  @Test
  fun removesInstalledOlderAndPartialTrustIdApksOnly() {
    val dir = tmp.newFolder(OtaFiles.DIR_NAME)
    for (name in listOf(
      "TrustID-1.apk",
      "TrustID-2.apk",
      "TrustID-3.apk",
      "TrustID-3.apk.part",
      "notes.txt",
      "OtherApp-9.apk",
    )) {
      File(dir, name).writeText("x")
    }
    val removed = OtaFiles.cleanStale(dir, installedVersionCode = 2)
    assertEquals(listOf("TrustID-1.apk", "TrustID-2.apk", "TrustID-3.apk.part"), removed.sorted())
    assertEquals(listOf("OtherApp-9.apk", "TrustID-3.apk", "notes.txt"), names(dir))
  }

  @Test
  fun keepsOnlyTheAdvertisedVersion() {
    val dir = tmp.newFolder(OtaFiles.DIR_NAME)
    File(dir, "TrustID-3.apk").writeText("x")
    File(dir, "TrustID-4.apk").writeText("x")
    OtaFiles.cleanStale(dir, installedVersionCode = 2, keepVersionCode = 4)
    assertEquals(listOf("TrustID-4.apk"), names(dir))
  }

  @Test
  fun missingDirectoryIsNoop() {
    assertEquals(emptyList<String>(), OtaFiles.cleanStale(File(tmp.root, "absent"), 1))
  }
}
