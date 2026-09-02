import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, setSessionToken } from "../lib/api";
import { useAuth, type Identity } from "../lib/auth";
import { consumeReturnTo } from "../lib/returnTo";
import { AuthChrome } from "../components/AuthChrome";

type PollStatus = {
  requestId: string;
  status: string;
  message?: string;
  expiresAt?: string;
  applicationName?: string | null;
  deviceName?: string;
};

/**
 * Waiting room after cloud identity match — Master Device approval grants a
 * session without creating a second passkey.
 */
export function WaitingApprovalPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setIdentity, refresh } = useAuth();
  const pollToken = params.get("token") ?? "";
  const [status, setStatus] = useState<PollStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pollToken) {
      setError("Missing approval token");
      return;
    }
    let alive = true;
    async function tick() {
      try {
        const s = await api<PollStatus>(
          `/device-approvals/poll/${encodeURIComponent(pollToken)}`,
        );
        if (!alive) return;
        setStatus(s);
        if (s.status === "approved" || s.status === "temporary") {
          await finish(s.status);
        }
        if (s.status === "declined" || s.status === "expired") {
          setError(
            s.message ??
              (s.status === "declined"
                ? "Access was denied"
                : "Request expired"),
          );
        }
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : "Polling failed");
        }
      }
    }
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollToken]);

  async function finish(_mode: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const claimed = await api<{
        mode: string;
        enrollmentToken?: string;
        sessionToken?: string;
        identity?: Identity;
        offerSaveDeviceKey?: boolean;
      }>("/device-approvals/claim", {
        method: "POST",
        body: JSON.stringify({ pollToken }),
      });

      // Ambient / temporary: session only — never create another passkey.
      if (
        (claimed.mode === "temporary" ||
          claimed.mode === "ambient" ||
          claimed.mode === "trust") &&
        (claimed.sessionToken || claimed.identity)
      ) {
        if (claimed.sessionToken) setSessionToken(claimed.sessionToken);
        if (claimed.identity) setIdentity(claimed.identity);
        else await refresh();
        navigate(consumeReturnTo() ?? "/dashboard", { replace: true });
        return;
      }

      setError("Unexpected approval result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete approval");
      setBusy(false);
    }
  }

  function onName(e: FormEvent) {
    e.preventDefault();
  }

  return (
    <AuthChrome title="Waiting" backTo="/dashboard">
      <div className="panel surface-block">
        <div className="app-loading-ring waiting-ring" aria-hidden="true" />
        <h1>Waiting for approval</h1>
        <p className="lead">
          {status?.message ??
            "Waiting for approval from your Master Device…"}
        </p>
        {status?.applicationName && (
          <p className="notice">Application: {status.applicationName}</p>
        )}
        {status?.status === "pending" && (
          <p className="muted">
            Open TrustID on your primary device and approve this request.
            {status.expiresAt
              ? ` Expires ${new Date(status.expiresAt).toLocaleTimeString()}.`
              : ""}
          </p>
        )}
        {status?.status === "approved" && (
          <form onSubmit={onName}>
            <div className="field">
              <label htmlFor="deviceName">Name this device (optional)</label>
              <input
                id="deviceName"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. Work laptop"
              />
            </div>
            <p className="muted">Signing you in — no new passkey…</p>
          </form>
        )}
        {busy && <p className="muted">Completing sign-in…</p>}
        {error && <p className="error">{error}</p>}
        <Link className="btn btn-ghost continue-primary" to="/dashboard">
          Back
        </Link>
      </div>
    </AuthChrome>
  );
}
