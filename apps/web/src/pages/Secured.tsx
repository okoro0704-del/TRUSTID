import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth, type Identity } from "../lib/auth";
import { getSessionToken } from "../lib/api";

export function SecuredPage() {
  const { loading, identity } = useAuth();
  const location = useLocation();
  const fromState = (location.state as { identity?: Identity } | null)?.identity;
  const shown = identity ?? fromState;

  if (loading && !shown) return <div className="shell muted">Loading…</div>;
  if (!shown && !getSessionToken()) return <Navigate to="/" replace />;

  return (
    <div className="shell">
      <div className="topbar">
        <Link to="/dashboard" className="brand">
          TrustID
        </Link>
      </div>
      <div className="panel">
        <h1>Device secured ✓</h1>
        <p className="lead">
          Your device verified you and registered a trusted credential. TrustID
          received only cryptographic proof — not biometric data.
        </p>
        <p className="notice">{shown?.trustId ?? "TrustID created"}</p>
        <p className="muted">
          A passkey proves control of this credential. It does not by itself
          prove legal identity verification.
        </p>
        <Link className="btn btn-primary" to="/dashboard">
          Continue to dashboard
        </Link>
      </div>
    </div>
  );
}
