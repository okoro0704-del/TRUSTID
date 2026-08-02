import { FormEvent, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

type Onboarding = {
  userId: string;
  trustId: string;
  verified?: boolean;
};

export function SecurePage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const onboarding = useMemo(() => {
    const raw = sessionStorage.getItem("trustid.onboarding");
    return raw ? (JSON.parse(raw) as Onboarding) : null;
  }, []);
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!onboarding?.userId) return <Navigate to="/register" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const options = await api<PublicKeyCredentialCreationOptionsJSON>(
        "/auth/webauthn/register/options",
        {
          method: "POST",
          body: JSON.stringify({ userId: onboarding!.userId }),
        },
      );
      const response = await startRegistration({ optionsJSON: options });
      const result = await api<{
        trustId: string;
        profile: { firstName: string; lastName: string } | null;
      }>("/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({
          userId: onboarding!.userId,
          deviceName: deviceName || undefined,
          response,
        }),
      });
      sessionStorage.removeItem("trustid.onboarding");
      await refresh();
      void result;
      navigate("/dashboard");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Passkey registration failed. Use a supported browser/device.",
      );
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
      <form className="panel" onSubmit={onSubmit}>
        <h1>Secure the account</h1>
        <p className="lead">
          Create a passkey on this device. Biometrics or your device PIN may be
          used — TrustID never stores a password.
        </p>
        <p className="notice">Your TrustID will be {onboarding.trustId}</p>
        <div className="field">
          <label htmlFor="deviceName">Device name</label>
          <input
            id="deviceName"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g. Laptop"
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating passkey…" : "Create passkey"}
        </button>
      </form>
    </div>
  );
}

type PublicKeyCredentialCreationOptionsJSON = Parameters<
  typeof startRegistration
>[0]["optionsJSON"];
