package com.trustid.device.plugins

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.util.Base64
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Headless CameraX face capture — waits until a face-like frame is present,
 * then returns JPEG for JS-side vectorization (shared web/PWA/APK model).
 */
@CapacitorPlugin(
  name = "TrustIdSilentFaceCapture",
  permissions = [
    Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
  ],
)
class SilentFaceCapturePlugin : Plugin() {

  companion object {
    private const val WARMUP_FRAMES = 8
    private const val MIN_NATIVE_CONFIDENCE = 0.55
    private const val CAPTURE_TIMEOUT_SEC = 8L
  }

  @PluginMethod
  fun isAvailable(call: PluginCall) {
    val available = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FRONT)
    val ret = JSObject()
    ret.put("available", available)
    call.resolve(ret)
  }

  @PluginMethod
  fun captureFaceVector(call: PluginCall) {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
      != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissionForAlias("camera", call, "cameraPermsCallback")
      return
    }
    runCapture(call)
  }

  @PermissionCallback
  private fun cameraPermsCallback(call: PluginCall) {
    if (getPermissionState("camera") == PermissionState.GRANTED) {
      runCapture(call)
    } else {
      call.reject("Camera permission denied")
    }
  }

  private fun runCapture(call: PluginCall) {
    val activity = activity
    if (activity !is LifecycleOwner) {
      call.reject("Silent face capture requires a LifecycleOwner activity")
      return
    }

    val latch = CountDownLatch(1)
    val done = AtomicBoolean(false)
    val settled = AtomicBoolean(false)
    val frameIndex = AtomicInteger(0)
    val result = JSObject()
    val executor = Executors.newSingleThreadExecutor()

    fun settleResolve(payload: JSObject) {
      if (settled.compareAndSet(false, true)) {
        call.resolve(payload)
      }
    }

    fun settleReject(message: String) {
      if (settled.compareAndSet(false, true)) {
        call.reject(message)
      }
    }

    fun unbindSafe(provider: ProcessCameraProvider?) {
      try {
        provider?.unbindAll()
      } catch (_: Exception) {
      }
    }

    val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
    cameraProviderFuture.addListener({
      var cameraProvider: ProcessCameraProvider? = null
      try {
        cameraProvider = cameraProviderFuture.get()
        val analysis = ImageAnalysis.Builder()
          .setTargetResolution(Size(320, 240))
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()

        analysis.setAnalyzer(executor) { image ->
          if (done.get() || settled.get()) {
            try {
              image.close()
            } catch (_: Exception) {
            }
            return@setAnalyzer
          }

          val idx = frameIndex.incrementAndGet()
          // Let CameraX autofocus / exposure settle — do not accept the first empty spin frame.
          if (idx <= WARMUP_FRAMES) {
            try {
              image.close()
            } catch (_: Exception) {
            }
            return@setAnalyzer
          }

          try {
            val jpeg = imageProxyToJpeg(image)
            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
            val confidence = if (bmp != null) estimateFaceConfidence(bmp) else 0.0
            if (bmp != null && !bmp.isRecycled) bmp.recycle()

            if (confidence < MIN_NATIVE_CONFIDENCE) {
              // Keep scanning until a face-like frame appears.
              return@setAnalyzer
            }

            if (!done.compareAndSet(false, true)) return@setAnalyzer

            result.put("confidence", confidence)
            result.put(
              "jpegBase64",
              Base64.encodeToString(jpeg, Base64.NO_WRAP),
            )
            result.put("width", image.width)
            result.put("height", image.height)
            unbindSafe(cameraProvider)
            latch.countDown()
          } catch (e: Exception) {
            // Keep trying until timeout unless this was a fatal bind issue.
          } finally {
            try {
              image.close()
            } catch (_: Exception) {
            }
          }
        }

        cameraProvider.unbindAll()
        cameraProvider.bindToLifecycle(
          activity,
          CameraSelector.DEFAULT_FRONT_CAMERA,
          analysis,
        )
      } catch (e: Exception) {
        done.set(true)
        latch.countDown()
        settleReject("Camera bind failed: ${e.message}")
      }
    }, ContextCompat.getMainExecutor(context))

    Thread {
      try {
        val ok = latch.await(CAPTURE_TIMEOUT_SEC, TimeUnit.SECONDS)
        if (!ok) {
          done.compareAndSet(false, true)
          try {
            ProcessCameraProvider.getInstance(context).get().unbindAll()
          } catch (_: Exception) {
          }
          settleReject("No face detected. Look straight at the front camera.")
          return@Thread
        }
        if (settled.get()) return@Thread
        if (result.length() == 0 || result.has("error") || !result.has("jpegBase64")) {
          settleReject(result.getString("error") ?: "No face detected in camera frame")
          return@Thread
        }
        settleResolve(result)
      } catch (e: Exception) {
        settleReject(e.message ?: "Silent face capture failed")
      }
    }.start()
  }

  private fun imageProxyToJpeg(image: ImageProxy): ByteArray {
    val yBuffer = image.planes[0].buffer
    val uBuffer = image.planes[1].buffer
    val vBuffer = image.planes[2].buffer
    val ySize = yBuffer.remaining()
    val uSize = uBuffer.remaining()
    val vSize = vBuffer.remaining()
    val nv21 = ByteArray(ySize + uSize + vSize)
    yBuffer.get(nv21, 0, ySize)
    vBuffer.get(nv21, ySize, vSize)
    uBuffer.get(nv21, ySize + vSize, uSize)

    val yuv = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
    val out = ByteArrayOutputStream()
    yuv.compressToJpeg(Rect(0, 0, image.width, image.height), 85, out)
    return out.toByteArray()
  }

  /**
   * Stronger than brightness-only: center ROI structure + edges so empty rooms fail.
   */
  private fun estimateFaceConfidence(bmp: Bitmap): Double {
    val w = bmp.width
    val h = bmp.height
    if (w < 48 || h < 48) return 0.0

    val sample = IntArray(w * h)
    bmp.getPixels(sample, 0, w, 0, 0, w, h)

    val cx0 = (w * 0.22).toInt()
    val cx1 = (w * 0.78).toInt()
    val cy0 = (h * 0.12).toInt()
    val cy1 = (h * 0.78).toInt()

    var globalLuma = 0.0
    var globalSq = 0.0
    var roiLuma = 0.0
    var roiSq = 0.0
    var roiCount = 0
    var skinCount = 0
    var edgeSum = 0.0
    var edgeCount = 0

    fun luma(px: Int): Double {
      val r = (px shr 16) and 0xFF
      val g = (px shr 8) and 0xFF
      val b = px and 0xFF
      return 0.299 * r + 0.587 * g + 0.114 * b
    }

    fun isSkin(px: Int): Boolean {
      val r = (px shr 16) and 0xFF
      val g = (px shr 8) and 0xFF
      val b = px and 0xFF
      val y = luma(px)
      if (y < 40 || y > 230) return false
      val rg = abs(r - g)
      return r >= 60 && g >= 40 && b >= 20 && r >= b - 10 && rg < 90 && r - b > -20
    }

    for (y in 0 until h) {
      for (x in 0 until w) {
        val px = sample[y * w + x]
        val yv = luma(px)
        globalLuma += yv
        globalSq += yv * yv
        if (x < cx0 || x >= cx1 || y < cy0 || y >= cy1) continue
        roiCount++
        roiLuma += yv
        roiSq += yv * yv
        if (isSkin(px)) skinCount++
        if (x + 1 < cx1 && y + 1 < cy1) {
          val y2 = luma(sample[y * w + (x + 1)])
          val y3 = luma(sample[(y + 1) * w + x])
          edgeSum += abs(yv - y2) + abs(yv - y3)
          edgeCount++
        }
      }
    }

    val n = (w * h).toDouble()
    val mean = globalLuma / n
    val variance = maxOf(0.0, globalSq / n - mean * mean)
    val roiMean = if (roiCount > 0) roiLuma / roiCount else 0.0
    val roiVar = if (roiCount > 0) maxOf(0.0, roiSq / roiCount - roiMean * roiMean) else 0.0
    val skinRatio = if (roiCount > 0) skinCount.toDouble() / roiCount else 0.0
    val edgeMean = if (edgeCount > 0) edgeSum / edgeCount else 0.0

    if (mean < 35 || mean > 225) return 0.0
    if (variance < 180) return 0.0
    if (roiVar < 220) return 0.0
    if (edgeMean < 8) return 0.0
    if (skinRatio < 0.08 && edgeMean < 14) return 0.0

    val brightnessScore = 1.0 - minOf(1.0, abs(roiMean - 120.0) / 120.0)
    val structureScore = minOf(1.0, sqrt(roiVar) / 55.0)
    val edgeScore = minOf(1.0, edgeMean / 28.0)
    val skinScore = minOf(1.0, skinRatio / 0.25)
    return minOf(
      1.0,
      maxOf(0.0, brightnessScore * 0.2 + structureScore * 0.35 + edgeScore * 0.3 + skinScore * 0.15),
    )
  }
}
