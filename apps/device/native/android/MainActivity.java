package com.trustid.device;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.trustid.device.plugins.AppLockPlugin;
import com.trustid.device.plugins.BiometricGatePlugin;
import com.trustid.device.plugins.HeadsUpNotificationPlugin;
import com.trustid.device.plugins.MediaVaultPlugin;
import com.trustid.device.plugins.SilentAuthPlugin;
import com.trustid.device.plugins.SilentFaceCapturePlugin;

public class MainActivity extends BridgeActivity {
    public static final String HEADS_UP_CHANNEL_ID = "trust_id_security_alerts";
    public static final String HEADS_UP_CHANNEL_LEGACY = "high_importance_approval_channel";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricGatePlugin.class);
        registerPlugin(MediaVaultPlugin.class);
        registerPlugin(AppLockPlugin.class);
        registerPlugin(SilentAuthPlugin.class);
        registerPlugin(SilentFaceCapturePlugin.class);
        registerPlugin(HeadsUpNotificationPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        ensureHeadsUpApprovalChannels();
    }

    /** IMPORTANCE_HIGH so approval pushes appear as heads-up popups. */
    private void ensureHeadsUpApprovalChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        createHighChannel(
            nm,
            HEADS_UP_CHANNEL_ID,
            "Security & Master Device Approvals",
            "Login approval requests that require immediate attention"
        );
        createHighChannel(
            nm,
            HEADS_UP_CHANNEL_LEGACY,
            "Critical Security Approvals",
            "Legacy approval channel"
        );
    }

    private void createHighChannel(
        NotificationManager nm,
        String id,
        String name,
        String description
    ) {
        NotificationChannel existing = nm.getNotificationChannel(id);
        if (existing != null && existing.getImportance() >= NotificationManager.IMPORTANCE_HIGH) {
            return;
        }
        if (existing != null) {
            nm.deleteNotificationChannel(id);
        }
        NotificationChannel channel = new NotificationChannel(
            id,
            name,
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(description);
        channel.enableVibration(true);
        channel.setShowBadge(true);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
    }
}
