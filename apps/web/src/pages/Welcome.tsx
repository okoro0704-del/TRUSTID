import { Link, Navigate } from "react-router-dom";
import { useRef } from "react";
import { useAuth } from "../lib/auth";
import { consumeReturnTo, peekReturnTo } from "../lib/returnTo";

export function WelcomePage() {
  const { loading, identity } = useAuth();
  const resumeTo = useRef<string | null>(null);

  if (!loading && identity) {
    if (resumeTo.current === null) {
      resumeTo.current = consumeReturnTo() ?? "/dashboard";
    }
    return <Navigate to={resumeTo.current} replace />;
  }

  return (
    <div className="shell">
      <section className="hero">
        <h1 className="hero-brand">TrustID</h1>
        <p className="hero-tag">One identity for your ecosystem.</p>
        {peekReturnTo() && (
          <p className="notice">Sign in to continue authorizing the application.</p>
        )}
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
