import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    () => (params.get("code") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    [params],
  );
  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [phase, setPhase] = useState<
    "enter" | "ready" | "passkey" | "done"
  >("enter");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const claiming = useRef(false);

  const refreshStatus = useCallback(async (c: string) => {
    const s = await api<EnrollmentStatus>(
      `/devices/enrollment/${encodeURIComponent(c.trim().toUpperCase())}`,
    );
    setStatus(s);
    return s;
  }, []);

  const claim = useCallback(async (c: string) => {
    if (claiming.current) return;
    claiming.current = true;
    setBusy(true);
    setError(null);
    try {
      const claimed = await api<{ enrollmentToken: string }>(
        `/devices/enrollment/${encodeURIComponent(c.trim().toUpperCase())}/claim`,
        { method: "POST", body: "{}" },
      );
      setToken(claimed.enrollmentToken);
      setPhase("passkey");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not use this code");
      claiming.current = false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!initialCode) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await refreshStatus(initialCode);
        if (cancelled) return;
        if (s.canEnroll || s.status === "approved") {
          setPhase("ready");
          await claim(initialCode);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Invalid code");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialCode, refreshStatus, claim]);

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized.length < 4) {
      setError("Enter the 6-character code from your other device");
      return;
    }
    setCode(normalized);
    setError(null);
    setBusy(true);
    try {
      const s = await refreshStatus(normalized);
      if (s.canEnroll || s.status === "approved") {
        setPhase("ready");
        await claim(normalized);
      } else if (s.status === "pending") {
        setPhase("ready");
        setError(null);
      } else {
        setError("This code cannot be used right now");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  // Poll while waiting for pending (legacy invites)
  useEffect(() => {
    if (phase !== "ready" || token || status?.status !== "pending") return;
    const normalized = code.trim().toUpperCase();
    const t = setInterval(() => {
      refreshStatus(normalized)
        .then((s) => {
          if (s.canEnroll || s.status === "approved") {
            void claim(normalized);
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(t);
  }, [phase, token, status?.status, code, refreshStatus, claim]);

  async function registerPasskey(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const options = await api<
        Parameters<typeof startRegistration>[0]["optionsJSON"]
      >("/devices/enrollment/register/options", {
        method: "POST",
        body: JSON.stringify({ enrollmentToken: token }),
      });
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
      setPhase("done");
      navigate("/secured", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome title="Device code" backTo="/continue">
      <div className="panel surface-block">
        <h1>Sign in with a device code</h1>
        <p className="lead">
          Enter the code shown on your trusted (master) device, then create a
          passkey on this device.
        </p>

        {phase === "enter" && (
          <form onSubmit={onSubmitCode}>
            <div className="field">
              <label htmlFor="code">6-character code</label>
              <input
                id="code"
                className="enroll-code-input"
                value={code}
                onChange={(e) =>
                  setCode(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6),
                  )
                }
                inputMode="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABC123"
                required
                minLength={4}
                maxLength={6}
                autoFocus
              />
            </div>
            <button className="btn btn-primary continue-primary" type="submit" disabled={busy}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </form>
        )}

        {phase === "ready" && !token && status?.status === "pending" && (
          <p className="notice">
            Waiting for approval on your trusted device…
          </p>
        )}

        {(phase === "passkey" || token) && (
          <form onSubmit={registerPasskey}>
            <p className="notice">Code accepted. Create a passkey to finish.</p>
            <div className="field">
              <label htmlFor="deviceName">Name for this device</label>
              <input
                id="deviceName"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. Work phone"
                autoFocus
              />
            </div>
            <button
              className="btn btn-primary continue-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Waiting for passkey…" : "Create passkey & sign in"}
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}
        <p className="muted" style={{ marginTop: "1rem" }}>
          On your other device: Trust Center → Devices → Generate sign-in code.
        </p>
        <p className="muted">
          Prefer passkey? <Link to="/continue">Use passkey instead</Link>
        </p>
      </div>
    </AuthChrome>
  );
}
