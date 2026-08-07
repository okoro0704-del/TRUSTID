import { FormEvent, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { saveRememberedAccount } from "../lib/rememberedAccount";

type Onboarding = {
  userId: string;
  trustId: string;
  verified?: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

export function SecurePage() {
  const navigate = useNavigate();
  const { setIdentity } = useAuth();
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
      const verifyResult = await api<{
        sessionToken?: string;
        identity?: import("../lib/auth").Identity;
      }>("/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({
          userId: onboarding!.userId,
          deviceName: deviceName || undefined,
          response,
        }),
      });
      if (verifyResult.sessionToken) setSessionToken(verifyResult.sessionToken);
      if (verifyResult.identity) setIdentity(verifyResult.identity);

      saveRememberedAccount({
        firstName:
          onboarding!.firstName ||
          verifyResult.identity?.profile?.firstName ||
          "",
        lastName:
          onboarding!.lastName || verifyResult.identity?.profile?.lastName,
        displayName: verifyResult.identity?.profile?.name,
        email: onboarding!.email,
        phone: onboarding!.phone,
        deviceName: deviceName.trim() || undefined,
        trustId: onboarding!.trustId || verifyResult.identity?.trustId,
      });

      sessionStorage.removeItem("trustid.onboarding");
      navigate("/secured", {
        replace: true,
        state: { identity: verifyResult.identity },
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Device security setup failed. Use a WebAuthn-capable browser.",
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
        <h1>Secure this TrustID with your device</h1>
        <p className="lead">
          Your device will create a passkey. Your biometric or device security
          method stays on your device. TrustID never receives your fingerprint
          or face data.
        </p>
        <p className="notice">
          TrustID stores a public cryptographic credential. Your private
          credential remains protected by your device.
        </p>
        <p className="muted">Your TrustID will be {onboarding.trustId}</p>
        <div className="field">
          <label htmlFor="deviceName">Device name</label>
          <input
            id="deviceName"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g. Laptop"
            autoComplete="off"
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Waiting for your device…" : "Create passkey"}
        </button>
      </form>
    </div>
  );
}

type PublicKeyCredentialCreationOptionsJSON = Parameters<
  typeof startRegistration
>[0]["optionsJSON"];
