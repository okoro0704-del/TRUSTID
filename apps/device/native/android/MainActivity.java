package com.trustid.device;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.trustid.device.plugins.AppLockPlugin;
import com.trustid.device.plugins.BiometricGatePlugin;
import com.trustid.device.plugins.MediaVaultPlugin;
import com.trustid.device.plugins.SilentAuthPlugin;
import com.trustid.device.plugins.SilentFaceCapturePlugin;

public class MainActivity extends BridgeActivity {
    public static final String HEADS_UP_CHANNEL_ID = "high_importance_approval_channel";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricGatePlugin.class);
        registerPlugin(MediaVaultPlugin.class);
        registerPlugin(AppLockPlugin.class);
        registerPlugin(SilentAuthPlugin.class);
        registerPlugin(SilentFaceCapturePlugin.class);
        super.onCreate(savedInstanceState);
        // Task switcher / screenshot protection for Trust ID itself
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        ensureHeadsUpApprovalChannel();
    }

    /** IMPORTANCE_HIGH so FCM approval pushes appear as heads-up popups. */
    private void ensureHeadsUpApprovalChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(HEADS_UP_CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel channel = new NotificationChannel(
            HEADS_UP_CHANNEL_ID,
            "Critical Security Approvals",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Login approval requests that require immediate attention");
        channel.enableVibration(true);
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }
}
