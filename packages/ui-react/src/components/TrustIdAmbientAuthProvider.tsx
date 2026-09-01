import type { ReactNode } from "react";
import {
  useAmbientTrustIdAuth,
  type UseAmbientTrustIdAuthOptions,
} from "../hooks/useAmbientTrustIdAuth.js";

export type TrustIdAmbientAuthProviderProps = UseAmbientTrustIdAuthOptions & {
  children: ReactNode;
  brand?: string;
};

function AmbientSplash({ brand }: { brand: string }) {
  return (
    <div className="tid-ambient-splash" role="status" aria-live="polite">
      <div className="tid-ambient-splash-panel">
        <div className="tid-silent-splash-mark" aria-hidden="true" />
        <h1 className="tid-silent-splash-brand">{brand}</h1>
        <p className="tid-ambient-splash-msg">
          Trust ID is verifying you…
        </p>
        <div className="tid-silent-splash-ring" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * Global zero-UI auth shell — mounts ambient biometric pipeline on boot.
 * OS biometric prompt is the only user-facing interaction.
 */
export function TrustIdAmbientAuthProvider({
  children,
  brand = "TrustID",
  ...options
}: TrustIdAmbientAuthProviderProps) {
  const { phase, error, retry } = useAmbientTrustIdAuth(options);

  if (phase === "AUTHENTICATED") {
    return <>{children}</>;
  }

  if (phase === "ERROR") {
    return (
      <div className="tid-ambient-splash" role="alert">
        <div className="tid-ambient-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-ambient-splash-msg">{error ?? "Verification paused"}</p>
          <button type="button" className="tid-btn tid-btn-primary" onClick={retry}>
            Retry biometric
          </button>
        </div>
      </div>
    );
  }

  // CHECKING | PROMPTING | ENROLLING — lightweight background state only
  return <AmbientSplash brand={brand} />;
}
