import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth, type Identity } from "../lib/auth";
import { consumeReturnTo, peekReturnTo } from "../lib/returnTo";

export function ContinuePage() {
  const navigate = useNavigate();
  const { identity, setIdentity } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in when arriving here (e.g. OAuth resume) — go to consent/app, not dashboard by default
  if (identity && !busy) {
    const next = peekReturnTo() ? consumeReturnTo()! : null;
    if (next) return <Navigate to={next} replace />;
  }

  async function authenticate(email?: string, phone?: string) {
    setBusy(true);
    setError(null);
    try {
      const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
        "/auth/webauthn/login/options",
        {
          method: "POST",
          body: JSON.stringify({ email, phone }),
        },
      );
      const response = await startAuthentication({ optionsJSON: options });
      const result = await api<{ sessionToken?: string; identity?: Identity }>(
        "/auth/webauthn/login/verify",
        {
          method: "POST",
          body: JSON.stringify({ response }),
        },
      );
      if (result.sessionToken) setSessionToken(result.sessionToken);
      if (result.identity) setIdentity(result.identity);
      const next = consumeReturnTo() ?? "/dashboard";
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") || "").trim();
    const phone = String(fd.get("phone") || "").trim();
    await authenticate(email || undefined, phone || undefined);
  }

  return (
    <div className="shell">
      <div className="topbar">
        <Link to="/" className="brand">
          TrustID
        </Link>
      </div>
      <form className="panel" onSubmit={onSubmit}>
        <h1>Use this device</h1>
        <p className="lead">
          Authenticate with your trusted device credential. Your device verifies
          you locally — TrustID never receives fingerprint or face data.
        </p>
        {peekReturnTo() && (
          <p className="notice">
            After you sign in, you will return to authorize the application.
          </p>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username webauthn" />
        </div>
        <div className="field">
          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" type="tel" />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="inline-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Authenticating…" : "Use passkey"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => authenticate()}
          >
            Discover passkey
          </button>
        </div>
        <p className="muted" style={{ marginTop: "1rem" }}>
          New here? <Link to="/register">Create TrustID</Link>
        </p>
      </form>
    </div>
  );
}
