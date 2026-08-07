import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuth, type Identity } from "../lib/auth";
import { getSessionToken } from "../lib/api";
import { AuthChrome } from "../components/AuthChrome";

export function SecuredPage() {
  const navigate = useNavigate();
  const { loading, identity } = useAuth();
  const location = useLocation();
  const fromState = (location.state as { identity?: Identity } | null)?.identity;
  const shown = identity ?? fromState;

  useEffect(() => {
    const returnTo = sessionStorage.getItem("trustid.returnTo");
    if (!returnTo) return;
    if (shown || getSessionToken()) {
      sessionStorage.removeItem("trustid.returnTo");
      navigate(returnTo, { replace: true });
    }
  }, [shown, navigate]);

  if (loading && !shown) {
    return (
      <AuthChrome title="Secured">
        <p className="muted">Loading…</p>
      </AuthChrome>
    );
  }
  if (!shown && !getSessionToken()) return <Navigate to="/" replace />;

  const returnTo = sessionStorage.getItem("trustid.returnTo");

  return (
    <AuthChrome title="Secured" backTo="/dashboard">
      <div className="panel surface-block">
        <div className="success-seal" aria-hidden="true">
          <span className="success-check">✓</span>
        </div>
        <h1>Device secured</h1>
        <p className="lead">
          Your device registered a trusted credential. TrustID received only
          cryptographic proof — not biometric data.
        </p>
        <p className="notice">{shown?.trustId ?? "TrustID created"}</p>
        <p className="muted">
          A passkey proves control of this credential. It does not by itself
          prove legal identity verification.
        </p>
        {returnTo ? (
          <button
            type="button"
            className="btn btn-primary continue-primary"
            onClick={() => {
              sessionStorage.removeItem("trustid.returnTo");
              navigate(returnTo);
            }}
          >
            Continue to app
          </button>
        ) : (
          <Link className="btn btn-primary continue-primary" to="/dashboard">
            Open Trust Center
          </Link>
        )}
      </div>
    </AuthChrome>
  );
}
