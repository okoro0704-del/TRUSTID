import type { ReactNode } from "react";
import {
  useAmbientTrustIdAuth,
  type UseAmbientTrustIdAuthOptions,
} from "../hooks/useAmbientTrustIdAuth.js";

export type TrustIdAmbientAuthProviderProps = UseAmbientTrustIdAuthOptions & {
  children: ReactNode;
  brand?: string;
};

function AmbientSplash({ brand, msg }: { brand: string; msg: string }) {
  return (
    <div className="tid-ambient-splash" role="status" aria-live="polite">
      <div className="tid-ambient-splash-panel">
        <div className="tid-silent-splash-mark" aria-hidden="true" />
        <h1 className="tid-silent-splash-brand">{brand}</h1>
        <p className="tid-ambient-splash-msg">{msg}</p>
        <div className="tid-silent-splash-ring" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * Global identity-first auth shell — cloud biometric before any device key.
 */
export function TrustIdAmbientAuthProvider({
  children,
  brand = "TrustID",
  ...options
}: TrustIdAmbientAuthProviderProps) {
  const { phase, error, retry, continueAfterApproval, lastResult } =
    useAmbientTrustIdAuth(options);

  if (phase === "AUTHENTICATED") {
    return <>{children}</>;
  }

  if (phase === "NEEDS_APPROVAL") {
    return (
      <div className="tid-ambient-splash" role="status">
        <div className="tid-ambient-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-ambient-splash-msg">
            Identity matched
            {lastResult?.trustId ? ` (${lastResult.trustId})` : ""}. Waiting for
            your Master Device to allow this terminal…
          </p>
          <p className="tid-ambient-splash-msg">
            Approve the request on your primary phone, then tap Continue.
          </p>
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            onClick={continueAfterApproval}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (phase === "ERROR") {
    return (
      <div className="tid-ambient-splash" role="alert">
        <div className="tid-ambient-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-ambient-splash-msg">{error ?? "Verification paused"}</p>
          <button type="button" className="tid-btn tid-btn-primary" onClick={retry}>
            Retry face verification
          </button>
        </div>
      </div>
    );
  }

  const msg =
    phase === "ENROLLING"
      ? "Creating your Trust ID in the cloud registry…"
      : "Matching your face to the Trust ID cloud registry — not a device passkey…";

  return <AmbientSplash brand={brand} msg={msg} />;
}
