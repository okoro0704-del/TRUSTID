import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Live web shell (default):
 *   CAP_USE_LIVE_WEB=1 (default) → load https://trustedid.netlify.app
 *   so UI/auth features update on launch after Netlify deploys.
 *
 * Bundled shell (offline / native-only testing):
 *   CAP_USE_LIVE_WEB=0 → use packaged apps/web/dist assets only.
 *
 * Override URL:
 *   CAP_SERVER_URL=https://your-preview.netlify.app
 */
const useLiveWeb = process.env.CAP_USE_LIVE_WEB?.trim() !== "0";
const liveUrl =
  process.env.CAP_SERVER_URL?.trim() || "https://trustedid.netlify.app";

const config: CapacitorConfig = {
  appId: "com.trustid.device",
  appName: "TrustID",
  webDir: "../web/dist",
  server: {
    androidScheme: "https",
    ...(useLiveWeb
      ? {
          url: liveUrl,
          cleartext: false,
        }
      : {}),
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    TrustIdBiometricGate: {},
    TrustIdMediaVault: {},
    TrustIdAppLock: {},
    TrustIdSilentAuth: {},
    TrustIdSilentFaceCapture: {},
  },
};

export default config;
