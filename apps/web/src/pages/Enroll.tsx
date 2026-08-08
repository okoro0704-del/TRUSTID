import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, setSessionToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AuthChrome } from "../components/AuthChrome";

type EnrollmentStatus = {
  id: string;
  status: string;
  expiresAt: string;
  canEnroll: boolean;
  canSignIn?: boolean;
};

type ClaimResult = {
  mode: "session";
  sessionToken: string;
  trustId: string;
  note?: string;
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
  const [deviceName, setDeviceName] = useState("");
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [phase, setPhase] = useState<"enter" | "signing_in" | "done">("enter");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const claiming = useRef(false);

  const refreshStatus = useCallback(async (c: string) => {
    const s = await api<EnrollmentStatus>(
      `/devices/enrollment/${encodeURIComponent(c.trim().toUpperCase())}`,
    );
    setStatus(s);
    return s;
  }, []);

  const claimAndSignIn = useCallback(
    async (c: string, name?: string) => {
      if (claiming.current) return;
      claiming.current = true;
      setBusy(true);
      setPhase("signing_in");
      setError(null);
      try {
        const claimed = await api<ClaimResult>(
          `/devices/enrollment/${encodeURIComponent(c.trim().toUpperCase())}/claim`,
          {
            method: "POST",
            body: JSON.stringify({
              deviceName: name?.trim() || undefined,
            }),
          },
        );
        if (claimed.sessionToken) setSessionToken(claimed.sessionToken);
        await refresh();
        setPhase("done");
        navigate("/dashboard", { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not sign in with this code");
        setPhase("enter");
        claiming.current = false;
      } finally {
        setBusy(false);
      }
    },
    [navigate, refresh],
  );

  useEffect(() => {
    if (!initialCode) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await refreshStatus(initialCode);
        if (cancelled) return;
        if (s.canSignIn || s.canEnroll || s.status === "approved") {
          await claimAndSignIn(initialCode);
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
  }, [initialCode, refreshStatus, claimAndSignIn]);

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
      if (s.canSignIn || s.canEnroll || s.status === "approved") {
        await claimAndSignIn(normalized, deviceName);
      } else if (s.status === "pending") {
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

  // Poll legacy pending codes
  useEffect(() => {
    if (status?.status !== "pending" || claiming.current) return;
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    const t = setInterval(() => {
      refreshStatus(normalized)
        .then((s) => {
          if (s.canSignIn || s.canEnroll || s.status === "approved") {
            void claimAndSignIn(normalized, deviceName);
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(t);
  }, [status?.status, code, deviceName, refreshStatus, claimAndSignIn]);

  return (
    <AuthChrome title="Device code" backTo="/continue">
      <div className="panel surface-block">
        <h1>Sign in with a device code</h1>
        <p className="lead">
          Enter the code from your master device. You’ll sign in here without
          creating another passkey — your passkey stays on the master device.
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
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, "")
                      .slice(0, 6),
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
            <div className="field">
              <label htmlFor="deviceName">Name for this device (optional)</label>
              <input
                id="deviceName"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. Work laptop"
              />
            </div>
            <button
              className="btn btn-primary continue-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {phase === "signing_in" && (
          <p className="notice">Signing you in with the master-device code…</p>
        )}

        {status?.status === "pending" && phase === "enter" && (
          <p className="notice">Waiting for approval on your trusted device…</p>
        )}

        {error && <p className="error">{error}</p>}
        <p className="muted" style={{ marginTop: "1rem" }}>
          On your master device: Trust Center → Devices → Generate sign-in code.
        </p>
        <p className="muted">
          Prefer passkey on this device?{" "}
          <Link to="/continue">Use passkey instead</Link>
        </p>
      </div>
    </AuthChrome>
  );
}
