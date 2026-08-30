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
 *
 * Loading splash only for CHECKING / PROMPTING_BIOMETRIC.
 * NEEDS_ACCOUNT immediately unmounts the spinner and shows CreateTrustIdAccount.
 */
export function TrustIdSmartAuthGuard({
  children,
  getInstallId,
  brand = "TrustID",
  renderCreate,
  onAuthenticated,
  probingMessage = "Looking for your Trust ID on this device…",
}: TrustIdSmartAuthGuardProps) {
  const { phase, authState, error, createAccount, retryProbe } = useTrustIdAuth({
    getInstallId,
    onAuthenticated,
  });

  // Prefer authState alias; phase is kept for callers/tests.
  const state = authState ?? phase;

  if (state === "AUTHENTICATED") {
    return <>{children}</>;
  }

  // Instant hand-off — never leave the biometric spinner mounted here.
  if (state === "NEEDS_ACCOUNT" || state === "CREATING_ACCOUNT") {
    if (renderCreate) {
      return (
        <>
          {renderCreate({
            busy: state === "CREATING_ACCOUNT",
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
        busy={state === "CREATING_ACCOUNT"}
        error={error}
        onCreate={() => {
          void createAccount();
        }}
      />
    );
  }

  if (state === "ERROR") {
    return (
      <div className="tid-silent-splash" role="alert">
        <div className="tid-silent-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-silent-splash-msg">
            {error ?? "Something went wrong."}
          </p>
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

  // CHECKING | PROMPTING_BIOMETRIC only
  return <Splash brand={brand} message={probingMessage} phase={state} />;
}
