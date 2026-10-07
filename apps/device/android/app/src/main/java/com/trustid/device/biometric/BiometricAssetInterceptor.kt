package com.trustid.device.biometric

import android.os.Build
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient

/**
 * Routes /__trustid_native__/ requests to the APK, for both the page and its
 * service worker (the TrustID PWA worker controls the page, so its fetches go
 * through the service-worker client). Every other request keeps Capacitor's
 * normal handling.
 */
object BiometricAssetInterceptor {
  fun install(bridge: Bridge) {
    val assets = bridge.activity.assets
    bridge.setWebViewClient(object : BridgeWebViewClient(bridge) {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val path = request.url.path
        if (NativeBiometricAssets.owns(path)) return NativeBiometricAssets.respond(assets, path)
        return super.shouldInterceptRequest(view, request)
      }
    })
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
        override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? {
          val path = request.url.path
          return if (NativeBiometricAssets.owns(path)) NativeBiometricAssets.respond(assets, path) else null
        }
      })
    }
  }
}
