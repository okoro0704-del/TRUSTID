package com.trustid.device.biometric

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewNetworkStateTest {
  @Test
  fun onlineOnlyWithADefaultNetworkThatCarriesInternet() {
    assertTrue(WebViewNetworkState.isOnline(hasDefaultNetwork = true, hasInternetCapability = true))
    assertFalse(WebViewNetworkState.isOnline(hasDefaultNetwork = false, hasInternetCapability = false))
    assertFalse(WebViewNetworkState.isOnline(hasDefaultNetwork = true, hasInternetCapability = false))
  }
}
