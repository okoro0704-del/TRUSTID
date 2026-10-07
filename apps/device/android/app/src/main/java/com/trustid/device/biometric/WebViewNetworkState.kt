package com.trustid.device.biometric

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.webkit.WebView

/**
 * Keeps the WebView's `navigator.onLine` (and its online/offline events) in
 * step with Android connectivity. A WebView does not track connectivity on its
 * own: without WebView.setNetworkAvailable it reports online forever, so the
 * SDK could not tell "biometric engine ready" from "identification available"
 * on a phone with no network (observed on device, Delivery V2 verification).
 */
object WebViewNetworkState {
  /** Online means the default network can carry internet traffic. Pure: unit-tested. */
  fun isOnline(hasDefaultNetwork: Boolean, hasInternetCapability: Boolean): Boolean =
    hasDefaultNetwork && hasInternetCapability

  fun install(context: Context, webView: WebView) {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    fun publish(online: Boolean) = webView.post { webView.setNetworkAvailable(online) }

    publish(currentlyOnline(cm))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
    cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        publish(isOnline(true, caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)))
      }

      override fun onLost(network: Network) {
        publish(currentlyOnline(cm))
      }
    })
  }

  private fun currentlyOnline(cm: ConnectivityManager): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      @Suppress("DEPRECATION")
      return cm.activeNetworkInfo?.isConnected == true
    }
    val network = cm.activeNetwork
    val caps = network?.let { cm.getNetworkCapabilities(it) }
    return isOnline(network != null, caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
  }
}
