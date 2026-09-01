package com.trustid.device.plugins

import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/**
 * Headless CameraX face capture — no preview, no disk storage.
 * Captures one frame via ImageAnalysis, vectorizes in memory, tears down immediately.
 */
@CapacitorPlugin(name = "TrustIdSilentFaceCapture")
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
    val activity = activity
    if (activity !is LifecycleOwner) {
      call.reject("Silent face capture requires a LifecycleOwner activity")
      return
    }

    val latch = CountDownLatch(1)
    val done = AtomicBoolean(false)
    val result = JSObject()
    val executor = Executors.newSingleThreadExecutor()

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
              val rgba = yuvToRgba(image)
              val width = image.width
              val height = image.height
              val vector = vectorizeFaceFromRgba(rgba, width, height)
              val confidence = vector.second
              val embedding = JSArray()
              for (v in vector.first) {
                embedding.put(v)
              }
              result.put("confidence", confidence)
              result.put("embedding", embedding)
            } catch (e: Exception) {
              result.put("confidence", 0.0)
              result.put("embedding", JSArray())
            } finally {
              image.close()
              cameraProvider.unbindAll()
              latch.countDown()
            }
          } else {
            image.close()
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
        call.reject("Camera bind failed: ${e.message}")
      }
    }, ContextCompat.getMainExecutor(context))

    Thread {
      val ok = latch.await(5, TimeUnit.SECONDS)
      if (!ok && done.compareAndSet(false, true)) {
        call.reject("Silent face capture timed out")
        return@Thread
      }
      if (result.length() == 0) {
        call.reject("No face frame captured")
        return@Thread
      }
      call.resolve(result)
    }.start()
  }

  private fun yuvToRgba(image: ImageProxy): IntArray {
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
    yuv.compressToJpeg(Rect(0, 0, image.width, image.height), 80, out)
    val jpeg = out.toByteArray()
    val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
      ?: return IntArray(image.width * image.height * 4)
    val scaled = Bitmap.createScaledBitmap(bmp, image.width, image.height, true)
    val pixels = IntArray(scaled.width * scaled.height)
    scaled.getPixels(pixels, 0, scaled.width, 0, 0, scaled.width, scaled.height)
    bmp.recycle()
    scaled.recycle()
    return pixels
  }

  private fun vectorizeFaceFromRgba(pixels: IntArray, width: Int, height: Int): Pair<DoubleArray, Double> {
    val dims = 128
    val grid = kotlin.math.ceil(sqrt(dims.toDouble())).toInt()
    val cellW = width.toDouble() / grid
    val cellH = height.toDouble() / grid
    val v = DoubleArray(dims)
    var lumaSum = 0.0
    var lumaSq = 0.0
    var centerLumaSum = 0.0
    var centerCount = 0
    val cx0 = width * 0.25
    val cx1 = width * 0.75
    val cy0 = height * 0.2
    val cy1 = height * 0.85

    for (y in 0 until height) {
      for (x in 0 until width) {
        val px = pixels[y * width + x]
        val r = (px shr 16) and 0xFF
        val g = (px shr 8) and 0xFF
        val b = px and 0xFF
        val luma = 0.299 * r + 0.587 * g + 0.114 * b
        lumaSum += luma
        lumaSq += luma * luma
        val gx = minOf(grid - 1, (x / cellW).toInt())
        val gy = minOf(grid - 1, (y / cellH).toInt())
        val idx = gy * grid + gx
        if (idx < dims) v[idx] += luma / 255.0
        if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) {
          centerLumaSum += luma
          centerCount++
        }
      }
    }

    val pixelsCount = width * height
    val meanLuma = lumaSum / pixelsCount
    val variance = maxOf(0.0, lumaSq / pixelsCount - meanLuma * meanLuma)
    val norm = sqrt(v.sum())
    val embedding = if (norm > 0) DoubleArray(dims) { i -> v[i] / norm } else DoubleArray(dims)

    val brightnessScore =
      if (meanLuma in 40.0..220.0) 1.0 - kotlin.math.abs(meanLuma - 128.0) / 128.0 else 0.0
    val varianceScore = minOf(1.0, sqrt(variance) / 64.0)
    val centerScore =
      if (centerCount > 0 && centerLumaSum / centerCount in 35.0..225.0) minOf(1.0, sqrt(variance) / 48.0)
      else 0.0
    val confidence = minOf(1.0, maxOf(0.0, brightnessScore * 0.35 + varianceScore * 0.35 + centerScore * 0.3))

    return Pair(embedding, confidence)
  }
}
