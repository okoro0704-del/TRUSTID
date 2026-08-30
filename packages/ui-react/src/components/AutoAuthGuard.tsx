import type { ReactNode } from "react";
import { useTrustIdAuth } from "../context/TrustIdAuthProvider.js";
import { useSilentAutoLogin } from "../hooks/useSilentAutoLogin.js";

export type AutoAuthGuardProps = {
  children: ReactNode;
  /**
   * When true (default), unauthenticated visitors are held on a splash while
   * zero-input biometric / passkey auto-login runs.
   */
  requireAuth?: boolean;
  /** Show splash while session probe or biometric prompt is in flight. */
  showSplash?: boolean;
  /** Optional branded title on the splash. */
  brand?: string;
  /** Optional supporting copy. */
  message?: string;
  /** Rendered when auto-login fails / is skipped and requireAuth is true. */
  fallback?: ReactNode;
  /** Disable auto biometric (manual login UX only). */
  autoLogin?: boolean;
  onAuthenticated?: () => void;
};

/**
 * Router session guard for Trust ID and connected ecosystem PWAs.
 * Holds render for unauthenticated users, runs silent biometric login,
 * then reveals the requested route on success.
 */
export function AutoAuthGuard({
  children,
  requireAuth = true,
  showSplash = true,
  brand = "TrustID",
  message = "Unlocking with your device biometric…",
  fallback = null,
  autoLogin = true,
  onAuthenticated,
}: AutoAuthGuardProps) {
  const { loading, identity } = useTrustIdAuth();
  const { status, prompting, error } = useSilentAutoLogin({
    enabled: autoLogin && !identity,
    onSuccess: onAuthenticated,
  });

  const authenticating =
    loading || prompting || status === "prompting" || status === "waiting_session";

  if (identity) {
    return <>{children}</>;
  }

  if (authenticating && showSplash) {
    return (
      <div className="tid-silent-splash" role="status" aria-live="polite">
        <div className="tid-silent-splash-panel">
          <div className="tid-silent-splash-mark" aria-hidden="true" />
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-silent-splash-msg">{message}</p>
          <div className="tid-silent-splash-ring" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!requireAuth) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return (
    <div className="tid-silent-splash" role="status">
      <div className="tid-silent-splash-panel">
        <h1 className="tid-silent-splash-brand">{brand}</h1>
        <p className="tid-silent-splash-msg">
          {error
            ? error
            : "No passkey found on this device. Sign in or create a TrustID to continue."}
        </p>
      </div>
    </div>
  );
}
