package com.trustid.device.biometric

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBiometricAssetsTest {
  @Test
  fun resolvesReleaseFilesToTheBundledAsset() {
    assertEquals(
      "public/biometric/9cc6e4a75f0e2bf0/w600k_mbf.onnx",
      NativeBiometricAssets.resolve("/__trustid_native__/biometric/9cc6e4a75f0e2bf0/w600k_mbf.onnx"),
    )
    assertEquals(
      "public/biometric/06b3f98e5aa2fffe/ort-wasm-simd-threaded.wasm",
      NativeBiometricAssets.resolve("/__trustid_native__/biometric/06b3f98e5aa2fffe/ort-wasm-simd-threaded.wasm"),
    )
  }

  @Test
  fun refusesTraversalAndAnythingOutsideTheRelease() {
    val refused = listOf(
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/../../index.html",
      "/__trustid_native__/biometric/../capacitor.config.json",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/..",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/a..b",
      "/__trustid_native__/biometric/9CC6E4A75F0E2BF0/w600k_mbf.onnx",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf/w600k_mbf.onnx",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/sub/w600k_mbf.onnx",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/.hidden",
      "/__trustid_native__/models/w600k_mbf.onnx",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/w600k_mbf.onnx.gz",
      "/__trustid_native__/biometric/9cc6e4a75f0e2bf0/w600k_mbf.onnx.gz.bin",
      "/biometric/9cc6e4a75f0e2bf0/w600k_mbf.onnx",
      "",
      null,
    )
    for (path in refused) assertNull("must refuse $path", NativeBiometricAssets.resolve(path))
  }

  @Test
  fun ownsEverythingUnderThePrefixSoNothingThereReachesTheNetwork() {
    assertTrue(NativeBiometricAssets.owns("/__trustid_native__/biometric/x"))
    assertTrue(NativeBiometricAssets.owns("/__trustid_native__/anything"))
    assertFalse(NativeBiometricAssets.owns("/biometric/9cc6e4a75f0e2bf0/w600k_mbf.onnx"))
    assertFalse(NativeBiometricAssets.owns("/api/v1/session"))
    assertFalse(NativeBiometricAssets.owns(null))
  }
}
