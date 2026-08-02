import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function SecuredPage() {
  const { loading, identity } = useAuth();
  if (loading) return <div className="shell muted">Loading…</div>;
  if (!identity) return <Navigate to="/" replace />;

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
        <p className="notice">{identity.trustId}</p>
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
