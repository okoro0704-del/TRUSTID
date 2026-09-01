import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  TrustIdAuthProvider,
  TrustIdAmbientAuthProvider,
} from "@trustid/ui-react";
import "@trustid/ui-react/styles.css";
import { App } from "./App";
import { createWebAmbientCapture } from "./lib/ambientCapture";
import { getOrCreateInstallId, markLocalOccupancy } from "./lib/deviceInstall";
import { rememberFromIdentity } from "./lib/rememberedAccount";
import "./styles.css";

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
      capturePayload={() => capture.payload()}
      allowAutoEnroll
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
