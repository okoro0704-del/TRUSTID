import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RouteGuard } from "@trustid/vault-sdk";

export type AppLockGuardOverlayProps = {
  path: string;
  routeGuard: RouteGuard;
  children: ReactNode;
  reason?: string;
  onBlocked?: () => void;
  onGranted?: () => void;
};

/**
 * Intercepts locked routes and presents a full-screen biometric re-auth overlay.
 */
export function AppLockGuardOverlay({
  path,
  routeGuard,
  children,
  reason = "Unlock protected route",
  onBlocked,
  onGranted,
}: AppLockGuardOverlayProps) {
  const [state, setState] = useState<"checking" | "blocked" | "granted">("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const assertAccess = useCallback(async () => {
    setBusy(true);
    setError(null);
    setState("checking");
    try {
      await routeGuard.assertRouteAccess(path);
      setState("granted");
      onGranted?.();
    } catch (e) {
      setState("blocked");
      setError(e instanceof Error ? e.message : "Route locked");
      onBlocked?.();
    } finally {
      setBusy(false);
    }
  }, [path, routeGuard, onBlocked, onGranted]);

  useEffect(() => {
    assertAccess().catch(() => undefined);
  }, [assertAccess]);

  if (state === "granted") {
    return <>{children}</>;
  }

  return (
    <>
      <div className="tid-applock-gate" role="dialog" aria-modal="true" aria-label="App lock gate">
        <div className="tid-applock-gate-panel">
          <div className="tid-applock-mark" aria-hidden="true" />
          <h2>Protected route</h2>
          <p className="tid-muted">{reason}</p>
          <p className="tid-muted">
            {state === "checking"
              ? "Checking app lock policy…"
              : "Complete biometric re-authentication to continue."}
          </p>
          {error && <p className="tid-error">{error}</p>}
          <div className="tid-actions">
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              disabled={busy}
              onClick={assertAccess}
              data-testid="applock-retry"
            >
              {busy ? "Waiting…" : "Unlock with biometric"}
            </button>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="tid-applock-decoy">
        {children}
      </div>
    </>
  );
}
