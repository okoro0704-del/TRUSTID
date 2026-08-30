import type { ReactNode } from "react";
import { TrustIdAuthProvider } from "../context/TrustIdAuthProvider.js";
import { TrustIdSmartAuthGuard } from "./TrustIdSmartAuthGuard.js";
import type { TrustIdIdentity } from "../types.js";

export type EcosystemAutoLoginProps = {
  children: ReactNode;
  apiBaseUrl: string;
  brand?: string;
  /** Required for silent account creation on first visit. */
  getInstallId: () => Promise<string>;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
  credentials?: RequestCredentials;
};

/**
 * Drop-in zero-field auth shell for ElfCom, Data Zone, FinProv, LifeOS, etc.
 * Probe ? biometric unlock, or Create Trust ID — never email/phone forms.
 */
export function EcosystemAutoLogin({
  children,
  apiBaseUrl,
  brand = "TrustID",
  getInstallId,
  onAuthenticated,
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
      <TrustIdSmartAuthGuard
        brand={brand}
        getInstallId={getInstallId}
        onAuthenticated={onAuthenticated}
      >
        {children}
      </TrustIdSmartAuthGuard>
    </TrustIdAuthProvider>
  );
}
