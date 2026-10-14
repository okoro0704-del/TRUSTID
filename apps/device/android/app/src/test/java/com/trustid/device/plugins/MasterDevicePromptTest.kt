package com.trustid.device.plugins

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MasterDevicePromptTest {
  private val stepUp = listOf(
    "trustid-step-up/v1",
    "challenge=Q2hhbGxlbmdlSWRDaGFsbGVuZ2VJZENoYWxsZW5nZUlk",
    "sub=TID-123456",
    "client=lifeos_portal_public",
    "action=mybrandos.likeness.approve",
    "operation=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "device=cm1device",
    "exp=2026-10-15T10:00:00.000Z",
  )

  @Test
  fun stepUpPromptComesFromThePayload() {
    val p = MasterDevicePrompt.describe(stepUp.joinToString("\n"))!!
    assertEquals("Approve: mybrandos.likeness.approve", p.title)
    assertEquals("Requested by lifeos_portal_public", p.subtitle)
    assertEquals("TrustID TID-123456", p.description)
  }

  @Test
  fun enrollmentAndRevocationPayloadsAreDescribed() {
    val enroll = listOf("trustid-master-device-enroll/v1", "enrollment=abc_DEF-123", "sub=TID-1", "key=KEYHASH", "exp=2026-10-15T10:00:00.000Z").joinToString("\n")
    assertEquals("Make this phone your Master Device", MasterDevicePrompt.describe(enroll)!!.title)
    val revoke = listOf("trustid-master-device-revoke/v1", "sub=TID-1", "device=cm1device").joinToString("\n")
    assertEquals("Remove this Master Device", MasterDevicePrompt.describe(revoke)!!.title)
  }

  @Test
  fun arbitraryOrMalformedPayloadsAreRefused() {
    assertNull(MasterDevicePrompt.describe("hello"))
    assertNull(MasterDevicePrompt.describe(""))
    // legacy and unknown formats are not signed by the Android Master Device key
    assertNull(MasterDevicePrompt.describe("trustid-master-challenge/v1\nchallenge=a\naction=b\npayload=c\nexp=d"))
    // missing, reordered, extra or injected fields
    assertNull(MasterDevicePrompt.describe(stepUp.dropLast(1).joinToString("\n")))
    assertNull(MasterDevicePrompt.describe((stepUp + "extra=1").joinToString("\n")))
    val swapped = stepUp.toMutableList().also { val t = it[3]; it[3] = it[4]; it[4] = t }
    assertNull(MasterDevicePrompt.describe(swapped.joinToString("\n")))
    val spoofedClient = stepUp.toMutableList().also { it[3] = "client=Your bank (safe)" }
    assertNull(MasterDevicePrompt.describe(spoofedClient.joinToString("\n")))
    val badAction = stepUp.toMutableList().also { it[4] = "action=Log in" }
    assertNull(MasterDevicePrompt.describe(badAction.joinToString("\n")))
    assertNull(MasterDevicePrompt.describe(stepUp.joinToString("\r\n")))
    assertNull(MasterDevicePrompt.describe(stepUp.joinToString("\n") + "x".repeat(3000)))
  }
}
