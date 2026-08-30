import { Navigate, useNavigate } from "react-router-dom";
import { TrustIdSmartAuthGuard } from "@trustid/ui-react";
import { getOrCreateInstallId, markLocalOccupancy } from "../lib/deviceInstall";
import { rememberFromIdentity } from "../lib/rememberedAccount";
import { consumeReturnTo } from "../lib/returnTo";

/**
 * Unified zero-field auth entry for Trust ID and ecosystem return_to flows.
 * Probes for an existing passkey ? biometric unlock, or Create Trust ID.
 */
export function AuthPage() {
  const navigate = useNavigate();

  return (
    <TrustIdSmartAuthGuard
      brand="TrustID"
      getInstallId={getOrCreateInstallId}
      onAuthenticated={(identity) => {
        rememberFromIdentity(identity);
        markLocalOccupancy(identity.trustId);
        navigate(consumeReturnTo() ?? "/dashboard", { replace: true });
      }}
    >
      <Navigate to="/dashboard" replace />
    </TrustIdSmartAuthGuard>
  );
}
