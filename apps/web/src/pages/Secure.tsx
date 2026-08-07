import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { saveRememberedAccount } from "../lib/rememberedAccount";
import { AuthChrome } from "../components/AuthChrome";

type Onboarding = {
  userId: string;
  trustId: string;
  verified?: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

type PublicKeyCredentialCreationOptionsJSON = Parameters<
  typeof startRegistration
>[0]["optionsJSON"];

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
  const [status, setStatus] = useState<string | null>(null);
  const optionsRef = useRef<PublicKeyCredentialCreationOptionsJSON | null>(null);
  const optionsAt = useRef(0);
  const userId = onboarding?.userId;

  async function loadOptions(force = false) {
    if (!userId) throw new Error("Missing onboarding user");
    if (
      !force &&
      optionsRef.current &&
      Date.now() - optionsAt.current < 90_000
    ) {
      return optionsRef.current;
    }
    const options = await api<PublicKeyCredentialCreationOptionsJSON>(
      "/auth/webauthn/register/options",
      {
        method: "POST",
        body: JSON.stringify({ userId }),
      },
    );
    const {
      challengeId: _c,
      purpose: _p,
      ...optionsJSON
    } = options as PublicKeyCredentialCreationOptionsJSON & {
      challengeId?: string;
      purpose?: string;
    };
    void _c;
    void _p;
    optionsRef.current = optionsJSON;
    optionsAt.current = Date.now();
    return optionsJSON;
  }

  useEffect(() => {
    if (!userId) return;
    void loadOptions().catch(() => undefined);
    // Warm options once per onboarding user so Android keeps user activation.
  }, [userId]);

  if (!userId || !onboarding) return <Navigate to="/register" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStatus("Preparing passkey…");
      const options = await loadOptions();
      setStatus("Waiting for your device…");
      const response = await startRegistration({ optionsJSON: options });
      optionsRef.current = null;
      setStatus("Verifying…");
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
      optionsRef.current = null;
      void loadOptions(true).catch(() => undefined);
      setError(
        err instanceof Error
          ? err.message
          : "Device security setup failed. Use a WebAuthn-capable browser.",
      );
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <AuthChrome title="Secure device" backTo="/verify">
      <form className="panel surface-block" onSubmit={onSubmit}>
        <h1>Secure this TrustID</h1>
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
        {status && <p className="muted">{status}</p>}
        <button
          className="btn btn-primary continue-primary"
          type="submit"
          disabled={busy}
          onPointerDown={() => void loadOptions().catch(() => undefined)}
          onTouchStart={() => void loadOptions().catch(() => undefined)}
        >
          {busy ? status || "Waiting for your device…" : "Create passkey"}
        </button>
      </form>
    </AuthChrome>
  );
}
