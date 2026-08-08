import { Link, Navigate } from "react-router-dom";
import { useRef } from "react";
import { useAuth } from "../lib/auth";
import { consumeReturnTo, peekReturnTo } from "../lib/returnTo";
import { getRememberedAccount } from "../lib/rememberedAccount";

export function WelcomePage() {
  const { loading, identity } = useAuth();
  const resumeTo = useRef<string | null>(null);
  const remembered = getRememberedAccount();

  if (!loading && identity) {
    if (resumeTo.current === null) {
      resumeTo.current = consumeReturnTo() ?? "/dashboard";
    }
    return <Navigate to={resumeTo.current} replace />;
  }

  if (!loading && !identity && remembered) {
    return <Navigate to="/continue" replace />;
  }

  return (
    <div className="app-frame auth-frame splash-frame">
      <div className="app-ambient splash-ambient" aria-hidden="true" />
      <main className="splash">
        <div className="splash-seal" aria-hidden="true">
          <span className="splash-seal-ring" />
          <span className="splash-seal-ring delay" />
          <span className="splash-seal-core" />
        </div>
        <h1 className="hero-brand splash-brand">TrustID</h1>
        <p className="hero-tag splash-tag">
          The identity layer for LifeOS and your ecosystem — passkeys, devices,
          and trust decisions in one place.
        </p>
        {peekReturnTo() && (
          <p className="notice">Sign in to continue authorizing the application.</p>
        )}
        <div className="hero-actions splash-actions">
          <Link className="btn btn-primary continue-primary" to="/register">
            Create TrustID
          </Link>
          <Link className="btn btn-ghost continue-primary" to="/continue">
            Use passkey
          </Link>
          <Link className="btn btn-ghost continue-primary" to="/enroll">
            I have a device code
          </Link>
        </div>
        <p className="splash-foot muted">
          Biometrics stay on your device. TrustID stores cryptographic proof only.
        </p>
      </main>
    </div>
  );
}
