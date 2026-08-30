import type { ReactNode } from "react";
import { CreateTrustIdAccount } from "./CreateTrustIdAccount.js";
import {
  useTrustIdAuth,
  type TrustIdAuthPhase,
} from "../hooks/useTrustIdAuth.js";
import type { TrustIdIdentity } from "../types.js";

export type TrustIdSmartAuthGuardProps = {
  children: ReactNode;
  getInstallId: () => Promise<string>;
  brand?: string;
  renderCreate?: (props: {
    busy: boolean;
    error: string | null;
    onCreate: () => void;
  }) => ReactNode;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
  probingMessage?: string;
};

function Splash({
  brand,
  message,
  phase,
}: {
  brand: string;
  message: string;
  phase: TrustIdAuthPhase;
}) {
  return (
    <div className="tid-silent-splash" role="status" aria-live="polite">
      <div className="tid-silent-splash-panel">
        <div className="tid-silent-splash-mark" aria-hidden="true" />
        <h1 className="tid-silent-splash-brand">{brand}</h1>
        <p className="tid-silent-splash-msg">
          {phase === "PROMPTING_BIOMETRIC"
            ? "Unlocking with Face ID / Fingerprint…"
            : message}
        </p>
        <div className="tid-silent-splash-ring" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * Unified app entry: silent probe ? biometric unlock OR create-account screen.
 * No email / phone / password fields.
 */
export function TrustIdSmartAuthGuard({
  children,
  getInstallId,
  brand = "TrustID",
  renderCreate,
  onAuthenticated,
  probingMessage = "Looking for your Trust ID on this device…",
}: TrustIdSmartAuthGuardProps) {
  const { phase, error, createAccount, retryProbe } = useTrustIdAuth({
    getInstallId,
    onAuthenticated,
  });

  if (phase === "AUTHENTICATED") {
    return <>{children}</>;
  }

  if (phase === "NEEDS_ACCOUNT" || phase === "CREATING_ACCOUNT") {
    if (renderCreate) {
      return (
        <>
          {renderCreate({
            busy: phase === "CREATING_ACCOUNT",
            error,
            onCreate: () => {
              void createAccount();
            },
          })}
        </>
      );
    }
    return (
      <CreateTrustIdAccount
        brand={brand}
        busy={phase === "CREATING_ACCOUNT"}
        error={error}
        onCreate={() => {
          void createAccount();
        }}
      />
    );
  }

  if (phase === "ERROR") {
    return (
      <div className="tid-silent-splash" role="alert">
        <div className="tid-silent-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-silent-splash-msg">{error ?? "Something went wrong."}</p>
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            onClick={retryProbe}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return <Splash brand={brand} message={probingMessage} phase={phase} />;
}
