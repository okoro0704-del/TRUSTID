import type { ReactNode } from "react";
import {
  AutoAuthGuard,
  TrustIdAuthProvider,
  type TrustIdIdentity,
} from "../index.js";

export type EcosystemAutoLoginProps = {
  children: ReactNode;
  /** Trust ID API base (`/api` via proxy, or absolute URL with credentials). */
  apiBaseUrl: string;
  /** Product brand shown on the splash (ElfCom, Data Zone, FinProv, …). */
  brand?: string;
  /** Called when silent biometric login succeeds. */
  onAuthenticated?: (identity: TrustIdIdentity) => void;
  /** Manual / OAuth fallback when no passkey is available. */
  fallback?: ReactNode;
  credentials?: RequestCredentials;
};

/**
 * Drop-in zero-input auth shell for connected ecosystem PWAs
 * (ElfCom, Data Zone, FinProv, LifeOS, …).
 *
 * Mount at the app root. On success the child tree renders with a Trust ID session.
 */
export function EcosystemAutoLogin({
  children,
  apiBaseUrl,
  brand = "TrustID",
  onAuthenticated,
  fallback,
  credentials = "include",
}: EcosystemAutoLoginProps) {
  return (
    <TrustIdAuthProvider
      apiBaseUrl={apiBaseUrl}
      credentials={credentials}
      enableRealtime={false}
      onIdentityChange={(identity) => {
        if (identity) onAuthenticated?.(identity);
      }}
    >
      <AutoAuthGuard
        brand={brand}
        message="Unlocking with your device biometric…"
        fallback={fallback ?? children}
        requireAuth={Boolean(fallback)}
        onAuthenticated={() => undefined}
      >
        {children}
      </AutoAuthGuard>
    </TrustIdAuthProvider>
  );
}
