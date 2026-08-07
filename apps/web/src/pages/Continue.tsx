import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
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
import {
  createLoginOptionsCache,
  runPasskeyLogin,
} from "../lib/passkeyAuth";
import { AuthChrome } from "../components/AuthChrome";

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
  const optionsCache = useRef(createLoginOptionsCache());

  const showQuick =
    Boolean(remembered) &&
    !switchAccount &&
    Boolean(remembered?.email || remembered?.phone);

  const contactHints = useCallback(() => {
    if (showQuick && remembered) {
      return {
        email: remembered.email,
        phone: remembered.phone,
      };
    }
    return {
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    };
  }, [showQuick, remembered, email, phone]);

  // Prefetch options while the page is open so Android can call credentials.get
  // immediately on tap (user activation). Never auto-start the ceremony.
  useEffect(() => {
    const hints = contactHints();
    if (!hints.email && !hints.phone && !showQuick) return;
    void optionsCache.current.prefetch(hints.email, hints.phone);
    const warm = window.setInterval(() => {
      void optionsCache.current.prefetch(hints.email, hints.phone);
    }, 75_000);
    return () => window.clearInterval(warm);
  }, [contactHints, showQuick]);

  const warmOptions = useCallback(() => {
    const hints = contactHints();
    void optionsCache.current.prefetch(hints.email, hints.phone);
  }, [contactHints]);

  const authenticate = useCallback(
    async (opts?: { email?: string; phone?: string }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      const emailHint = opts?.email?.trim() || undefined;
      const phoneHint = opts?.phone?.trim() || undefined;

      try {
        setStatus("Preparing passkey…");
        const optionsJSON = await optionsCache.current.take(emailHint, phoneHint);
        setStatus("Waiting for passkey…");
        // Ceremony must start ASAP after the gesture — options already ready.
        const response = await runPasskeyLogin(optionsJSON);
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
        optionsCache.current.invalidate();
        void optionsCache.current.prefetch(emailHint, phoneHint);
        const message =
          err instanceof Error ? err.message : "Sign-in failed";
        const cancelled =
          /not allowed|abort|cancel|timed out|timeout/i.test(message) ||
          (err as { name?: string })?.name === "NotAllowedError";
        setError(
          cancelled
            ? "Passkey prompt was dismissed or timed out. Tap Use passkey to try again."
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

  if (identity && !busy) {
    const next = peekReturnTo() ? consumeReturnTo()! : null;
    if (next) return <Navigate to={next} replace />;
  }

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
    optionsCache.current.invalidate();
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
                onPointerDown={warmOptions}
                onTouchStart={warmOptions}
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
                  onBlur={warmOptions}
                />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onBlur={warmOptions}
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
                onPointerDown={warmOptions}
                onTouchStart={warmOptions}
              >
                {busy ? status || "Authenticating…" : "Use passkey"}
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
