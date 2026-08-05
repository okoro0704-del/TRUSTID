import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuth, type Identity } from "../lib/auth";
import { getSessionToken } from "../lib/api";

export function SecuredPage() {
  const navigate = useNavigate();
  const { loading, identity } = useAuth();
  const location = useLocation();
  const fromState = (location.state as { identity?: Identity } | null)?.identity;
  const shown = identity ?? fromState;

  useEffect(() => {
    const returnTo = sessionStorage.getItem("trustid.returnTo");
    if (!returnTo) return;
    // Prefer completing OAuth/LifeOS handoff over staying on TrustID
    if (shown || getSessionToken()) {
      sessionStorage.removeItem("trustid.returnTo");
      navigate(returnTo, { replace: true });
    }
  }, [shown, navigate]);

  if (loading && !shown) return <div className="shell muted">Loading…</div>;
  if (!shown && !getSessionToken()) return <Navigate to="/" replace />;

  const returnTo = sessionStorage.getItem("trustid.returnTo");

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
        {returnTo ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              sessionStorage.removeItem("trustid.returnTo");
              navigate(returnTo);
            }}
          >
            Continue to app
          </button>
        ) : (
          <Link className="btn btn-primary" to="/dashboard">
            Continue to dashboard
          </Link>
        )}
      </div>
    </div>
  );
}
