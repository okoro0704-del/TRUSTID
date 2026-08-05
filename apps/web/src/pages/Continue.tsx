import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth, type Identity } from "../lib/auth";
import { consumeReturnTo, peekReturnTo } from "../lib/returnTo";

export function ContinuePage() {
  const navigate = useNavigate();
  const { identity, setIdentity } = useAuth();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (identity && !busy) {
    const next = peekReturnTo() ? consumeReturnTo()! : null;
    if (next) return <Navigate to={next} replace />;
  }

  async function authenticate(opts?: { email?: string; phone?: string }) {
    setBusy(true);
    setError(null);
    try {
      const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
        "/auth/webauthn/login/options",
        {
          method: "POST",
          body: JSON.stringify({
            email: opts?.email,
            phone: opts?.phone,
          }),
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
      navigate(consumeReturnTo() ?? "/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPasskey(e: FormEvent) {
    e.preventDefault();
    await authenticate({
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    });
  }

  async function onRequestApproval(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() && !phone.trim()) {
      setError("Enter email or phone to request approval");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const returnTo = peekReturnTo() ?? "";
      const clientIdMatch = /[?&]client_id=([^&]+)/.exec(returnTo);
      const appNameMatch = /[?&]app_name=([^&]+)/.exec(returnTo);
      const created = await api<{ pollToken: string }>(
        "/device-approvals",
        {
          method: "POST",
          body: JSON.stringify({
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            deviceName: deviceName.trim() || undefined,
            clientId: clientIdMatch
              ? decodeURIComponent(clientIdMatch[1]!)
              : undefined,
            applicationName: appNameMatch
              ? decodeURIComponent(appNameMatch[1]!)
              : undefined,
          }),
        },
      );
      navigate(
        `/waiting-approval?token=${encodeURIComponent(created.pollToken)}`,
        { replace: true },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request approval");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <div className="topbar">
        <Link to="/" className="brand">
          TrustID
        </Link>
      </div>
      <div className="panel">
        <h1>Use this device</h1>
        <p className="lead">
          Authenticate with a passkey on this device, or request approval from a
          primary trusted device if this one is new.
        </p>
        {peekReturnTo() && (
          <p className="notice">
            After you sign in, you will return to authorize the application.
          </p>
        )}
        <form onSubmit={onPasskey}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username webauthn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="phone">Phone</label>
            <input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="deviceName">Device name (for approval requests)</label>
            <input
              id="deviceName"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="e.g. Library PC"
            />
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
        <form onSubmit={onRequestApproval} style={{ marginTop: "1rem" }}>
          <button className="btn btn-ghost" type="submit" disabled={busy} style={{ width: "100%" }}>
            Request approval on trusted device
          </button>
        </form>
        <p className="muted" style={{ marginTop: "1rem" }}>
          New here? <Link to="/register">Create TrustID</Link>
        </p>
      </div>
    </div>
  );
}
