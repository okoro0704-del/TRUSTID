import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, setSessionToken } from "../lib/api";
import { useAuth, type Identity } from "../lib/auth";
import { consumeReturnTo, peekReturnTo } from "../lib/returnTo";
import {
  clearRememberedAccount,
  getRememberedAccount,
  rememberFromIdentity,
  saveRememberedAccount,
  type RememberedAccount,
} from "../lib/rememberedAccount";
import { AuthChrome } from "../components/AuthChrome";

type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

export function ContinuePage() {
  const navigate = useNavigate();
  const { identity, setIdentity } = useAuth();
  const [remembered, setRemembered] = useState<RememberedAccount | null>(() =>
    getRememberedAccount(),
  );
  const [switchAccount, setSwitchAccount] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [deviceName, setDeviceName] = useState(
    () => getRememberedAccount()?.deviceName ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);

  const showQuick =
    Boolean(remembered) &&
    !switchAccount &&
    Boolean(remembered?.email || remembered?.phone);

  if (identity && !busy) {
    const next = peekReturnTo() ? consumeReturnTo()! : null;
    if (next) return <Navigate to={next} replace />;
  }

  const authenticate = useCallback(
    async (opts?: { email?: string; phone?: string }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      setStatus("Waiting for passkey…");
      const emailHint = opts?.email?.trim() || undefined;
      const phoneHint = opts?.phone?.trim() || undefined;

      try {
        // Always request a fresh challenge on user gesture.
        // Prefetch/auto-start previously reused challenges and broke after logout
        // (React Strict Mode double-mount + consumed challenge).
        const options = await api<AuthOptions>("/auth/webauthn/login/options", {
          method: "POST",
          body: JSON.stringify({
            email: emailHint,
            phone: phoneHint,
          }),
        });

        // Library options only — strip our challengeId/purpose extras
        const {
          challengeId: _challengeId,
          purpose: _purpose,
          ...optionsJSON
        } = options as AuthOptions & {
          challengeId?: string;
          purpose?: string;
        };
        void _challengeId;
        void _purpose;

        const response = await startAuthentication({ optionsJSON });
        setStatus("Verifying…");
        const result = await api<{ sessionToken?: string; identity?: Identity }>(
          "/auth/webauthn/login/verify",
          {
            method: "POST",
            body: JSON.stringify({ response }),
          },
        );
        if (result.sessionToken) setSessionToken(result.sessionToken);
        if (result.identity) {
          setIdentity(result.identity);
          rememberFromIdentity(
            result.identity,
            deviceName.trim() || getRememberedAccount()?.deviceName,
          );
        } else if (emailHint || phoneHint) {
          const prev = getRememberedAccount();
          saveRememberedAccount({
            firstName: prev?.firstName ?? "",
            lastName: prev?.lastName,
            email: emailHint,
            phone: phoneHint,
            deviceName: deviceName.trim() || prev?.deviceName,
            trustId: prev?.trustId,
          });
        }
        navigate(consumeReturnTo() ?? "/dashboard", { replace: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Sign-in failed";
        // Browser cancel should not look like a broken account
        const cancelled =
          /not allowed|abort|cancel|timed out/i.test(message) ||
          (err as { name?: string })?.name === "NotAllowedError";
        setError(
          cancelled
            ? "Passkey prompt was dismissed. Tap Use passkey to try again."
            : message,
        );
      } finally {
        inFlight.current = false;
        setBusy(false);
        setStatus(null);
      }
    },
    [deviceName, navigate, setIdentity],
  );

  async function onPasskey(e: FormEvent) {
    e.preventDefault();
    if (showQuick && remembered) {
      await authenticate({
        email: remembered.email,
        phone: remembered.phone,
      });
      return;
    }
    await authenticate({
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    });
  }

  function onSwitchAccount() {
    clearRememberedAccount();
    setRemembered(null);
    setSwitchAccount(true);
    setEmail("");
    setPhone("");
    setDeviceName("");
    setError(null);
  }

  async function onRequestApproval(e?: FormEvent) {
    e?.preventDefault();
    const emailVal = (showQuick ? remembered?.email : email)?.trim();
    const phoneVal = (showQuick ? remembered?.phone : phone)?.trim();
    const deviceVal = (deviceName || remembered?.deviceName || "").trim();
    if (!emailVal && !phoneVal) {
      setError("Enter email or phone to request approval");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const returnTo = peekReturnTo() ?? "";
      const clientIdMatch = /[?&]client_id=([^&]+)/.exec(returnTo);
      const appNameMatch = /[?&]app_name=([^&]+)/.exec(returnTo);
      const created = await api<{ pollToken: string }>("/device-approvals", {
        method: "POST",
        body: JSON.stringify({
          email: emailVal || undefined,
          phone: phoneVal || undefined,
          deviceName: deviceVal || undefined,
          clientId: clientIdMatch
            ? decodeURIComponent(clientIdMatch[1]!)
            : undefined,
          applicationName: appNameMatch
            ? decodeURIComponent(appNameMatch[1]!)
            : undefined,
        }),
      });
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

  // Warm the API connection only (no challenge stored — avoids stale/double-use)
  useEffect(() => {
    if (!showQuick || !remembered) return;
    const ctrl = new AbortController();
    void fetch(`${import.meta.env.VITE_API_URL ?? "/api"}/health`, {
      signal: ctrl.signal,
      credentials: "include",
    }).catch(() => undefined);
    return () => ctrl.abort();
  }, [showQuick, remembered]);

  const contactLine = remembered
    ? [remembered.email, remembered.phone].filter(Boolean).join(" · ")
    : "";
  const firstName = remembered?.firstName || remembered?.displayName || "you";

  return (
    <AuthChrome title="Sign in">
      <div className="panel continue-panel surface-block">
        {showQuick && remembered ? (
          <>
            <p className="continue-eyebrow">Welcome back</p>
            <h1 className="continue-name">
              {remembered.displayName || remembered.firstName}
            </h1>
            <p className="lead continue-lead">
              Unlock with your passkey on this device.
            </p>
            <div className="continue-meta" aria-live="polite">
              {contactLine && (
                <div className="continue-meta-row">
                  <span className="muted">Account</span>
                  <span className="continue-meta-value">{contactLine}</span>
                </div>
              )}
              {remembered.deviceName && (
                <div className="continue-meta-row">
                  <span className="muted">Device</span>
                  <span className="continue-meta-value">{remembered.deviceName}</span>
                </div>
              )}
              {remembered.trustId && (
                <div className="continue-meta-row">
                  <span className="muted">TrustID</span>
                  <span className="continue-meta-value tid">{remembered.trustId}</span>
                </div>
              )}
            </div>
            {peekReturnTo() && (
              <p className="notice">You will return to authorize the application.</p>
            )}
            <form onSubmit={onPasskey}>
              {error && <p className="error">{error}</p>}
              {status && <p className="muted">{status}</p>}
              <button
                className="btn btn-primary continue-primary"
                type="submit"
                disabled={busy}
                autoFocus
              >
                {busy ? status || "Authenticating…" : "Use passkey"}
              </button>
            </form>
            <button
              className="btn btn-ghost continue-switch"
              type="button"
              disabled={busy}
              onClick={onSwitchAccount}
            >
              Not {firstName}? Sign in to another account
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy}
              onClick={() => void onRequestApproval()}
              style={{ width: "100%", marginTop: "0.35rem" }}
            >
              Request approval on trusted device
            </button>
          </>
        ) : (
          <>
            <h1>Continue with TrustID</h1>
            <p className="lead">
              Sign in with your passkey. Your biometric stays on this device.
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
                <label htmlFor="deviceName">Device name</label>
                <input
                  id="deviceName"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g. Library PC"
                />
              </div>
              {error && <p className="error">{error}</p>}
              <button
                className="btn btn-primary continue-primary"
                type="submit"
                disabled={busy}
              >
                {busy ? "Authenticating…" : "Use passkey"}
              </button>
            </form>
            <form onSubmit={onRequestApproval} style={{ marginTop: "0.75rem" }}>
              <button
                className="btn btn-ghost"
                type="submit"
                disabled={busy}
                style={{ width: "100%" }}
              >
                Request approval on trusted device
              </button>
            </form>
            <p className="muted" style={{ marginTop: "1rem" }}>
              New here? <Link to="/register">Create TrustID</Link>
            </p>
          </>
        )}
      </div>
    </AuthChrome>
  );
}
