import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  TrustIdAuthProvider,
  TrustIdAmbientAuthProvider,
} from "@trustid/ui-react";
import "@trustid/ui-react/styles.css";
import { App } from "./App";
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
import { createTrustIdSdk } from "@trustid/sdk";
import "./styles.css";

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
      capturePayload={() => capture.payload()}
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
    </BrowserRouter>
  </StrictMode>,
);
