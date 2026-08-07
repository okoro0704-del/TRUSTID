import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AuthChrome } from "../components/AuthChrome";

type EnrollmentStatus = {
  id: string;
  status: string;
  expiresAt: string;
  canEnroll: boolean;
};

export function EnrollPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const initialCode = useMemo(
    () => (params.get("code") ?? "").toUpperCase(),
    [params],
  );
  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  async function refreshStatus(c: string) {
    const s = await api<EnrollmentStatus>(
      `/devices/enrollment/${encodeURIComponent(c.trim().toUpperCase())}`,
    );
    setStatus(s);
    return s;
  }

  useEffect(() => {
    if (!initialCode) return;
    refreshStatus(initialCode).catch((err) =>
      setError(err instanceof Error ? err.message : "Invalid code"),
    );
    const t = setInterval(() => {
      refreshStatus(initialCode).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [initialCode]);

  async function onLookup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await refreshStatus(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    }
  }

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const claimed = await api<{ enrollmentToken: string }>(
        `/devices/enrollment/${encodeURIComponent(code.trim().toUpperCase())}/claim`,
        { method: "POST" },
      );
      setToken(claimed.enrollmentToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setBusy(false);
    }
  }

  async function registerPasskey(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/devices/enrollment/register/options",
        {
          method: "POST",
          body: JSON.stringify({ enrollmentToken: token }),
        },
      );
      const response = await startRegistration({ optionsJSON: options });
      const result = await api<{ sessionToken?: string }>(
        "/devices/enrollment/register/verify",
        {
          method: "POST",
          body: JSON.stringify({
            enrollmentToken: token,
            deviceName: deviceName || undefined,
            response,
          }),
        },
      );
      if (result.sessionToken) setSessionToken(result.sessionToken);
      await refresh();
      navigate("/secured");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome title="Enroll device">
      <div className="panel surface-block">
        <h1>Enroll this device</h1>
        <p className="lead">
          Enter the code from your existing trusted device. After approval,
          create a passkey here.
        </p>
        <form onSubmit={onLookup}>
          <div className="field">
            <label htmlFor="code">Enrollment code</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
            />
          </div>
          <button className="btn btn-ghost" type="submit">
            Check status
          </button>
        </form>
        {status && (
          <p className="notice">
            Status: {status.status}
            {status.status === "pending"
              ? " — approve on your existing device"
              : ""}
          </p>
        )}
        {status?.status === "approved" && !token && (
          <button className="btn btn-primary" type="button" disabled={busy} onClick={claim}>
            Continue enrollment
          </button>
        )}
        {token && (
          <form onSubmit={registerPasskey}>
            <div className="field">
              <label htmlFor="deviceName">Device name</label>
              <input
                id="deviceName"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. iPhone"
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Creating passkey…" : "Create passkey"}
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </AuthChrome>
  );
}
