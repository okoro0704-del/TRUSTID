import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  TrustIdAuthProvider,
  TrustIdAmbientAuthProvider,
} from "@trustid/ui-react";
import "@trustid/ui-react/styles.css";
import { App } from "./App";
import { NativeShellUpdateBanner } from "./components/NativeShellUpdateBanner";
import { createWebAmbientCapture, captureFingerprintBackup } from "./lib/ambientCapture";
import { getOrCreateInstallId, getLocalOccupancy, markLocalOccupancy } from "./lib/deviceInstall";
import { getRememberedAccount, rememberFromIdentity } from "./lib/rememberedAccount";
import { injectCapacitorSecurityBridges } from "./lib/security/nativeBridges";
import { promptLocalDeviceCredential } from "./lib/localDeviceAuth";
import {
  unlockBoundInstallWithPasskey,
  safeCaptureFingerprintBackup,
} from "./lib/trustidBiometrics";
import {
  storeSessionTokenSecure,
  storeMasterDeviceLocalState,
  peekCachedTrustId,
} from "./lib/secureSession";
import {
  ensureHeadsUpChannels,
  getNativePushToken,
} from "./lib/headsUpNotifications";
import { initElfComPushRegistration } from "./lib/notification_registration";
import {
  biometricReadiness,
  configureBiometricDelivery,
  createTrustIdSdk,
  schedulePrewarmBiometricEngine,
} from "@trustid/sdk";
import { registerSW } from "virtual:pwa-register";
import "./styles.css";

// New web code must reach a long-running app or tab, not only a fresh page
// load: check for an updated service worker whenever the page becomes
// visible (app opened or brought back) and every 30 minutes while open.
// autoUpdate then activates it and reloads onto the new release.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => {
      if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.setInterval(check, 30 * 60 * 1000);
  },
});

// Face recognition is made ready before sign-in: right away in the installed
// app (assets are bundled), at idle on the web (download once, then cached).
// This never opens the camera or reads a frame.
const biometricCdn = import.meta.env.VITE_TRUSTID_BIOMETRIC_ASSET_BASE?.trim();
if (biometricCdn) configureBiometricDelivery({ assetBaseUrls: [biometricCdn] });
void schedulePrewarmBiometricEngine().catch(() => undefined);

// APK / Capacitor: wire App Lock + biometric + media vault + heads-up plugins
injectCapacitorSecurityBridges();
void ensureHeadsUpChannels();

function AmbientShell({ children }: { children: React.ReactNode }) {
  const apiBaseUrl = import.meta.env.VITE_API_URL ?? "/api";

  const capture = useMemo(
    () =>
      createWebAmbientCapture(async (path, init) => {
        const res = await fetch(`${apiBaseUrl}${path}`, {
          ...init,
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
          },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            (err as { message?: string }).message ?? `HTTP ${res.status}`,
          );
        }
        return res.json();
      }),
    [apiBaseUrl],
  );

  return (
    <TrustIdAmbientAuthProvider
      apiBaseUrl={apiBaseUrl}
      getInstallId={getOrCreateInstallId}
      getLastTrustId={() =>
        peekCachedTrustId() ??
        getRememberedAccount()?.trustId ??
        getLocalOccupancy()?.trustId ??
        null
      }
      biometricReadiness={biometricReadiness}
      capturePayload={(opts) => capture.payload(opts)}
      captureEnrollmentPayload={(opts) => capture.enrollmentPayload(opts)}
      captureFingerprint={async () => {
        return captureFingerprintBackup(
          "Scan your fingerprint to unlock Trust ID",
        );
      }}
      allowAutoEnroll={false}
      hasBoundInstall={() => Boolean(getLocalOccupancy()?.trustId)}
      cryptographicInstallUnlock={async (installId) => {
        const result = await unlockBoundInstallWithPasskey(installId);
        return {
          ok: result.success,
          identity: result.identity as
            | import("@trustid/ui-react").TrustIdIdentity
            | undefined,
          sessionToken: result.sessionToken ?? null,
          error: result.error,
        };
      }}
      unlockWithDeviceCredential={async (reason) => {
        // Soft local UV only — API never accepts this alone.
        const result = await promptLocalDeviceCredential(reason);
        return result.ok;
      }}
      storeSessionToken={async (token) => {
        await storeSessionTokenSecure(token);
      }}
      getPushToken={getNativePushToken}
      persistMasterDeviceState={async (info) => {
        await storeMasterDeviceLocalState(info);
        if (info.trustId) markLocalOccupancy(info.trustId);
      }}
      registerFingerprintBackup={async () => {
        const fp = await safeCaptureFingerprintBackup(
          "Scan your fingerprint to save a Trust ID backup",
        );
        if (!fp.success || !fp.payload) return false;
        const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
        await sdk.enrollBiometric(fp.payload);
        return true;
      }}
      onAuthenticated={(identity) => {
        rememberFromIdentity(identity);
        markLocalOccupancy(identity.trustId);
        void storeMasterDeviceLocalState({
          trustId: identity.trustId,
          isMasterDevice: true,
        });
        void initElfComPushRegistration(identity.trustId, apiBaseUrl);
      }}
    >
      {children}
    </TrustIdAmbientAuthProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TrustIdAuthProvider
        apiBaseUrl={import.meta.env.VITE_API_URL ?? "/api"}
        enableRealtime
        onIdentityChange={(identity) => {
          if (identity) {
            rememberFromIdentity(identity);
            void initElfComPushRegistration(
              identity.trustId,
              import.meta.env.VITE_API_URL ?? "/api",
            );
          }
        }}
      >
        <AmbientShell>
          <App />
        </AmbientShell>
      </TrustIdAuthProvider>
      <NativeShellUpdateBanner />
    </BrowserRouter>
  </StrictMode>,
);
