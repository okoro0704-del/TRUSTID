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
import kotlin.math.sqrt

/**
 * Headless CameraX face capture — returns a JPEG frame for JS-side vectorization
 * so web / PWA / APK share one cloud face model.
 */
@CapacitorPlugin(
  name = "TrustIdSilentFaceCapture",
  permissions = [
    Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
  ],
)
class SilentFaceCapturePlugin : Plugin() {

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

    val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
    cameraProviderFuture.addListener({
      try {
        val cameraProvider = cameraProviderFuture.get()
        val analysis = ImageAnalysis.Builder()
          .setTargetResolution(Size(320, 240))
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()

        analysis.setAnalyzer(executor) { image ->
          if (done.compareAndSet(false, true)) {
            try {
              val jpeg = imageProxyToJpeg(image)
              val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
              val confidence = if (bmp != null) estimateConfidence(bmp) else 0.0
              if (bmp != null && !bmp.isRecycled) bmp.recycle()
              result.put("confidence", confidence)
              result.put(
                "jpegBase64",
                Base64.encodeToString(jpeg, Base64.NO_WRAP),
              )
              result.put("width", image.width)
              result.put("height", image.height)
            } catch (e: Exception) {
              result.put("confidence", 0.0)
              result.put("error", e.message ?: "frame_capture_failed")
            } finally {
              try {
                image.close()
              } catch (_: Exception) {
              }
              try {
                cameraProvider.unbindAll()
              } catch (_: Exception) {
              }
              latch.countDown()
            }
          } else {
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
        val ok = latch.await(5, TimeUnit.SECONDS)
        if (!ok) {
          done.compareAndSet(false, true)
          settleReject("Silent face capture timed out")
          return@Thread
        }
        if (settled.get()) return@Thread
        if (result.length() == 0 || result.has("error") || !result.has("jpegBase64")) {
          settleReject(result.getString("error") ?: "No face frame captured")
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

  private fun estimateConfidence(bmp: Bitmap): Double {
    val w = bmp.width
    val h = bmp.height
    if (w <= 0 || h <= 0) return 0.0
    val sample = IntArray(w * h)
    bmp.getPixels(sample, 0, w, 0, 0, w, h)
    var lumaSum = 0.0
    var lumaSq = 0.0
    for (px in sample) {
      val r = (px shr 16) and 0xFF
      val g = (px shr 8) and 0xFF
      val b = px and 0xFF
      val luma = 0.299 * r + 0.587 * g + 0.114 * b
      lumaSum += luma
      lumaSq += luma * luma
    }
    val n = sample.size.toDouble()
    val mean = lumaSum / n
    val variance = maxOf(0.0, lumaSq / n - mean * mean)
    val brightness =
      if (mean in 40.0..220.0) 1.0 - kotlin.math.abs(mean - 128.0) / 128.0 else 0.0
    val varianceScore = minOf(1.0, sqrt(variance) / 64.0)
    return minOf(1.0, maxOf(0.0, brightness * 0.5 + varianceScore * 0.5))
  }
}
