import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.trustid.device",
  appName: "TrustID",
  webDir: "../web/dist",
  server: {
    androidScheme: "https",
  },
  plugins: {
    TrustIdBiometricGate: {},
    TrustIdMediaVault: {},
    TrustIdAppLock: {},
  },
};

export default config;
