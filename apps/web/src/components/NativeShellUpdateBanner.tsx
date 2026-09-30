import { useEffect, useState } from "react";

/**
 * One-time bridge for Android shells built before the native OTA channel existed.
 * Those shells load this live site but lack the TrustIdAppUpdate plugin, so they
 * cannot update themselves yet. Shells that have the plugin never see this banner.
 *
 * The APK link uses the Netlify branch host on purpose: Capacitor opens other hosts
 * in the system browser, which hands the download to Android's package installer.
 */
const MANIFEST_PATH = "/releases/trustid-android.json";
const EXTERNAL_APK_URL = "https://main--trustedid.netlify.app/releases/TrustID.apk";
const DISMISS_KEY = "trustid.nativeShellUpdate.dismissedAt";
const DISMISS_MS = 3 * 24 * 60 * 60 * 1000;

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  PluginHeaders?: Array<{ name: string }>;
  isPluginAvailable?: (name: string) => boolean;
};

function isLegacyAndroidShell(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== "android") return false;
  const hasUpdater =
    cap.PluginHeaders?.some((p) => p.name === "TrustIdAppUpdate") ??
    cap.isPluginAvailable?.("TrustIdAppUpdate") ??
    false;
  return !hasUpdater;
}

function recentlyDismissed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

export function NativeShellUpdateBanner() {
  const [versionName, setVersionName] = useState<string | null>(null);

  useEffect(() => {
    if (!isLegacyAndroidShell() || recentlyDismissed()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    fetch(MANIFEST_PATH, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) return;
        const manifest = (await res.json()) as { applicationId?: string; versionName?: string };
        if (manifest.applicationId === "com.trustid.device" && manifest.versionName) {
          setVersionName(manifest.versionName);
        }
      })
      .catch(() => undefined)
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  if (!versionName) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage unavailable */
    }
    setVersionName(null);
  };

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        left: 12,
        right: 12,
        bottom: 12,
        zIndex: 2147483000,
        padding: "12px 14px",
        borderRadius: 14,
        background: "#0B3D3A",
        color: "#F4FBFA",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>TrustID {versionName} is available</div>
      <div style={{ opacity: 0.85, marginBottom: 10 }}>
        One-time install: after this version, TrustID downloads and verifies its own updates.
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={dismiss}
          style={{
            background: "transparent",
            color: "inherit",
            border: "1px solid rgba(244,251,250,0.35)",
            borderRadius: 10,
            padding: "8px 12px",
          }}
        >
          Later
        </button>
        <a
          href={EXTERNAL_APK_URL}
          style={{
            background: "#F4FBFA",
            color: "#0B3D3A",
            borderRadius: 10,
            padding: "8px 14px",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Install update
        </a>
      </div>
    </div>
  );
}
