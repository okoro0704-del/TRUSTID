import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth } from "../lib/auth";

export function ContinuePage() {
  const navigate = useNavigate();
  const { identity, refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (identity) return <Navigate to="/dashboard" replace />;

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
      const result = await api<{ sessionToken?: string }>("/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify({ response }),
      });
      if (result.sessionToken) setSessionToken(result.sessionToken);
      await refresh();
      const returnTo = sessionStorage.getItem("trustid.returnTo");
      if (returnTo) {
        sessionStorage.removeItem("trustid.returnTo");
        navigate(returnTo);
      } else {
        navigate("/dashboard");
      }
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
      </form>
    </div>
  );
}
