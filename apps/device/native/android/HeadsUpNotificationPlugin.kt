package com.trustid.device.plugins

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.trustid.device.MainActivity

/**
 * OS heads-up security alerts for Master Device approval requests.
 * Works for WebSocket-driven alerts even without Firebase; FCM uses the same channels.
 */
@CapacitorPlugin(name = "TrustIdHeadsUp")
class HeadsUpNotificationPlugin : Plugin() {

  companion object {
    const val CHANNEL_SECURITY = "trust_id_security_alerts"
    const val CHANNEL_LEGACY = "high_importance_approval_channel"
  }

  override fun load() {
    ensureChannels()
  }

  @PluginMethod
  fun ensureChannels(call: PluginCall) {
    ensureChannels()
    val ret = JSObject()
    ret.put("ok", true)
    ret.put("primaryChannelId", CHANNEL_SECURITY)
    call.resolve(ret)
  }

  @PluginMethod
  fun showApproval(call: PluginCall) {
    val title = call.getString("title") ?: "Login Approval Requested"
    val body = call.getString("body")
      ?: "A device is requesting account access. Tap to approve."
    val requestId = call.getString("requestId") ?: System.currentTimeMillis().toString()
    ensureChannels()

    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("open_approval", true)
      putExtra("requestId", requestId)
    }
    val pending = PendingIntent.getActivity(
      context,
      requestId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val notification = NotificationCompat.Builder(context, CHANNEL_SECURITY)
      .setSmallIcon(android.R.drawable.ic_dialog_alert)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setDefaults(NotificationCompat.DEFAULT_ALL)
      .setContentIntent(pending)
      .build()

    try {
      NotificationManagerCompat.from(context).notify(requestId.hashCode(), notification)
      val ret = JSObject()
      ret.put("ok", true)
      call.resolve(ret)
    } catch (e: SecurityException) {
      call.reject("Notification permission denied: ${e.message}")
    } catch (e: Exception) {
      call.reject(e.message ?: "showApproval failed")
    }
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    createChannel(
      nm,
      CHANNEL_SECURITY,
      "Security & Master Device Approvals",
      "Login approval requests that require immediate attention",
    )
    createChannel(
      nm,
      CHANNEL_LEGACY,
      "Critical Security Approvals",
      "Legacy approval channel",
    )
  }

  private fun createChannel(
    nm: NotificationManager,
    id: String,
    name: String,
    description: String,
  ) {
    val existing = nm.getNotificationChannel(id)
    if (existing != null && existing.importance >= NotificationManager.IMPORTANCE_HIGH) {
      return
    }
    if (existing != null) {
      nm.deleteNotificationChannel(id)
    }
    val channel = NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH).apply {
      this.description = description
      enableVibration(true)
      setShowBadge(true)
      lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
  }
}
