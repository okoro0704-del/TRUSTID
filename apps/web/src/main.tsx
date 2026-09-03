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
import { getOrCreateInstallId, markLocalOccupancy } from "./lib/deviceInstall";
import { getRememberedAccount, rememberFromIdentity } from "./lib/rememberedAccount";
import { injectCapacitorSecurityBridges } from "./lib/security/nativeBridges";
import { createTrustIdSdk } from "@trustid/sdk";
import "./styles.css";

// APK / Capacitor: wire App Lock + biometric + media vault plugins before UI mounts
injectCapacitorSecurityBridges();

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
      getLastTrustId={() => getRememberedAccount()?.trustId ?? null}
      capturePayload={() => capture.payload()}
      allowAutoEnroll
      registerFingerprintBackup={async () => {
        const fp = await captureFingerprintBackup(
          "Scan your fingerprint to save a Trust ID backup",
        );
        if (!fp) return false;
        const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
        await sdk.enrollBiometric(fp);
        return true;
      }}
      onAuthenticated={(identity) => {
        rememberFromIdentity(identity);
        markLocalOccupancy(identity.trustId);
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
          if (identity) rememberFromIdentity(identity);
        }}
      >
        <AmbientShell>
          <App />
        </AmbientShell>
      </TrustIdAuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
