import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function WelcomePage() {
  const { loading, identity } = useAuth();
  if (!loading && identity) return <Navigate to="/dashboard" replace />;

  return (
    <div className="shell">
      <section className="hero">
        <h1 className="hero-brand">TrustID</h1>
        <p className="hero-tag">One identity for your ecosystem.</p>
        <div className="hero-actions">
          <Link className="btn btn-primary" to="/register">
            Create TrustID
          </Link>
          <Link className="btn btn-ghost" to="/continue">
            Continue with TrustID
          </Link>
        </div>
      </section>
    </div>
  );
}
