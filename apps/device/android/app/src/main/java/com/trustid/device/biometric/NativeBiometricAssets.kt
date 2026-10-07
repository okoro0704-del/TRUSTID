package com.trustid.device.biometric

import android.content.res.AssetManager
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the biometric engine release that ships inside the APK.
 *
 * `npm run cap:sync:device` packages apps/web/dist, which contains
 * public/biometric/<sha256[0..16]>/<file> (scripts/stage-biometric-assets.mjs).
 * The live web app asks for those files at
 *   https://<app host>/__trustid_native__/biometric/<sha16>/<file>
 * and this class answers from the APK: no network, no model download.
 *
 * The web SDK verifies the SHA-256 of every byte it receives, so this layer
 * only has to be strict about which paths it will open. Anything under the
 * prefix that is not a well-formed release path gets a 404, never a network
 * fetch, and never another file of the APK.
 */
object NativeBiometricAssets {
  /** Contract version reported to the SDK (NativeBiometricAssetBridge.apiVersion). */
  const val API_VERSION = 1
  const val URL_PREFIX = "/__trustid_native__/"
  const val ASSET_ROOT = "public/biometric"

  private val DIR = Regex("^[0-9a-f]{16}$")
  private val FILE = Regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")

  /** True for any path this layer owns (and must never pass to the network). */
  fun owns(path: String?): Boolean = path != null && path.startsWith(URL_PREFIX)

  /**
   * APK asset path for a request path, or null when the path is not a
   * well-formed release file. Pure: unit-tested on the JVM.
   */
  fun resolve(path: String?): String? {
    if (path == null || !path.startsWith(URL_PREFIX)) return null
    val parts = path.removePrefix(URL_PREFIX).split('/')
    if (parts.size != 3 || parts[0] != "biometric") return null
    val dir = parts[1]
    val file = parts[2]
    if (!DIR.matches(dir) || !FILE.matches(file) || file.contains("..")) return null
    // Only decoded bytes ship in the app; the gzip copies exist for the network path only.
    if (file.endsWith(".gz") || file.endsWith(".gz.bin")) return null
    return "$ASSET_ROOT/$dir/$file"
  }

  /** Content directories (sha256 prefixes) present in this APK. */
  fun bundledDirs(assets: AssetManager): List<String> =
    try {
      assets.list(ASSET_ROOT)?.filter { DIR.matches(it) }?.sorted() ?: emptyList()
    } catch (_: IOException) {
      emptyList()
    }

  fun respond(assets: AssetManager, path: String?): WebResourceResponse {
    val assetPath = resolve(path) ?: return notFound()
    return try {
      val stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING)
      WebResourceResponse("application/octet-stream", null, 200, "OK", headers(), stream)
    } catch (_: IOException) {
      notFound()
    }
  }

  private fun headers(): Map<String, String> = mapOf(
    "Cache-Control" to "no-store",
    "X-Content-Type-Options" to "nosniff",
  )

  private fun notFound(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers(), ByteArrayInputStream(ByteArray(0)))
}
