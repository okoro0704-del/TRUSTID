package com.trustid.device;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import com.trustid.device.plugins.BiometricGatePlugin;
import com.trustid.device.plugins.MediaVaultPlugin;
import com.trustid.device.plugins.AppLockPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricGatePlugin.class);
        registerPlugin(MediaVaultPlugin.class);
        registerPlugin(AppLockPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
