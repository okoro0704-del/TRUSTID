import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** LifeOS Enter LifeOS — suppress gateway status chrome and prefer native passkey only. */
function isSilentLifeOsReturn(): boolean {
  const next = peekReturnTo();
  if (!next) return false;
  try {
    const q = new URL(next, window.location.origin).searchParams;
    if (q.get("ui_mode") === "silent") return true;
    return q.get("auth_mode") === "passkey" && q.get("lifeos_returning") === "1";
  } catch {
    return /[?&]ui_mode=silent\b/.test(next);
  }
}

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
  const silentAttempted = useRef(false);
  const optionsCache = useRef(createLoginOptionsCache());
  const silent = useMemo(() => isSilentLifeOsReturn(), []);

  const showQuick =
    Boolean(remembered) &&
    !switchAccount &&
    Boolean(remembered?.trustId);

  const contactHints = useCallback(() => {
    if (showQuick && remembered) {
      // Returning-user screen: identify by trustId when possible.
      // Never send empty/invalid email (caused iOS "Validation failed").
      // If trustId is missing, use discoverable passkeys (no contact lookup).
      if (remembered.trustId) return { trustId: remembered.trustId };
      return {};
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
    if (!hints.email && !hints.phone && !hints.trustId && !showQuick) return;
    void optionsCache.current.prefetch(hints);
    const warm = window.setInterval(() => {
      void optionsCache.current.prefetch(hints);
    }, 75_000);
    return () => window.clearInterval(warm);
  }, [contactHints, showQuick]);

  const warmOptions = useCallback(() => {
    void optionsCache.current.prefetch(contactHints());
  }, [contactHints]);

  const authenticate = useCallback(
    async (opts?: { email?: string; phone?: string; trustId?: string }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      const hints = {
        trustId: opts?.trustId?.trim() || undefined,
        email: opts?.trustId ? undefined : opts?.email?.trim() || undefined,
        phone: opts?.trustId ? undefined : opts?.phone?.trim() || undefined,
      };

      try {
        if (!silent) setStatus("Preparing passkey…");
        const optionsJSON = await optionsCache.current.take(hints);
        if (!silent) setStatus("Waiting for passkey…");
        // Ceremony must start ASAP after the gesture — options already ready.
        const response = await runPasskeyLogin(optionsJSON);
        if (!silent) setStatus("Verifying…");
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
        } else if (hints.trustId) {
          saveRememberedAccount({
            trustId: hints.trustId,
            displayName: hints.trustId,
            deviceName: deviceName.trim() || getRememberedAccount()?.deviceName,
          });
        }
        navigate(consumeReturnTo() ?? "/dashboard", { replace: true });
      } catch (err) {
        optionsCache.current.invalidate();
        void optionsCache.current.prefetch(hints);
        const message =
          err instanceof Error ? err.message : "Sign-in failed";
        const cancelled =
          /not allowed|abort|cancel|timed out|timeout/i.test(message) ||
          (err as { name?: string })?.name === "NotAllowedError";
        const unknownCred = /unknown credential/i.test(message);
        if (unknownCred) {
          // Server wipe / rotated RP: device still has a passkey TrustID no longer knows.
          clearRememberedAccount();
          optionsCache.current.invalidate();
          setRemembered(null);
          setSwitchAccount(true);
          setError(
            "This passkey is no longer registered on TrustID. Create a new TrustID, then sign in again. You can delete the old passkey in your device settings.",
          );
          return;
        }
        setError(
          cancelled
            ? silent
              ? "Passkey was dismissed or timed out. Tap Enter LifeOS Business to try again."
              : "Passkey prompt was dismissed or timed out. Tap Use passkey to try again."
            : message,
        );
      } finally {
        inFlight.current = false;
        setBusy(false);
        setStatus(null);
      }
    },
    [deviceName, navigate, setIdentity, silent],
  );

  // Silent LifeOS enter: invoke native credentials.get immediately with no status chrome.
  useEffect(() => {
    if (!silent || !showQuick || !remembered?.trustId) return;
    if (silentAttempted.current || identity) return;
    silentAttempted.current = true;
    void authenticate({ trustId: remembered.trustId });
  }, [silent, showQuick, remembered?.trustId, identity, authenticate]);

  if (identity && !busy) {
    const next = peekReturnTo() ? consumeReturnTo()! : null;
    if (next) return <Navigate to={next} replace />;
  }

  async function onPasskey(e: FormEvent) {
    e.preventDefault();
    if (showQuick && remembered) {
      await authenticate(
        remembered.trustId ? { trustId: remembered.trustId } : {},
      );
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
    const emailVal = email.trim() || undefined;
    const phoneVal = phone.trim() || undefined;
    const trustIdVal = showQuick ? remembered?.trustId : undefined;
    const deviceVal = (deviceName || remembered?.deviceName || "").trim();
    if (!emailVal && !phoneVal && !trustIdVal) {
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
          trustId: trustIdVal || undefined,
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

  const contactLine = remembered?.trustId ?? "";

  // Completely blank while LifeOS silent enter runs — only the OS passkey sheet should appear.
  if (silent && showQuick && !error) {
    return (
      <div
        className="silent-passkey-shell"
        style={{
          minHeight: "100dvh",
          background: "#0b1210",
          margin: 0,
        }}
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">Confirm with Face ID or fingerprint</span>
        <form
          onSubmit={onPasskey}
          style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}
        >
          <button type="submit" autoFocus tabIndex={-1} aria-hidden>
            Enter
          </button>
        </form>
      </div>
    );
  }

  if (silent && error) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "1.5rem",
          background: "#0b1210",
          color: "#f4f7f6",
        }}
      >
        <div style={{ width: "min(360px, 100%)", textAlign: "center" }}>
          <p className="error" style={{ color: "#ffb4a8" }}>
            {error}
          </p>
          <form onSubmit={onPasskey}>
            <button
              className="btn btn-primary continue-primary"
              type="submit"
              autoFocus
              onPointerDown={warmOptions}
              onTouchStart={warmOptions}
              style={{ width: "100%", marginTop: "1rem" }}
            >
              Enter LifeOS Business
            </button>
          </form>
          <button
            className="btn btn-ghost continue-switch"
            type="button"
            onClick={onSwitchAccount}
            style={{ width: "100%", marginTop: "0.65rem" }}
          >
            Log into another Account
          </button>
          <p className="muted" style={{ marginTop: "0.85rem", textAlign: "center" }}>
            <Link to="/enroll" style={{ color: "inherit" }}>
              I have a device code
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <AuthChrome title="Sign in">
      <div className="panel continue-panel surface-block">
        {showQuick && remembered ? (
          <>
            <p className="continue-eyebrow">Welcome back</p>
            <h1 className="continue-name">
              {remembered.displayName || remembered.trustId}
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
            {peekReturnTo() ? (
              <p className="notice">You will return to authorize the application.</p>
            ) : null}
            <form onSubmit={onPasskey}>
              {error && <p className="error">{error}</p>}
              {status ? <p className="muted">{status}</p> : null}
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
              Log into another Account
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
            <p className="muted" style={{ marginTop: "0.85rem", textAlign: "center" }}>
              <Link to="/enroll">I have a device code</Link>
            </p>
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
            <p className="muted" style={{ marginTop: "0.85rem", textAlign: "center" }}>
              <Link to="/enroll">I have a device code</Link>
            </p>
            <p className="muted" style={{ marginTop: "1rem" }}>
              New here? <Link to="/register">Create TrustID</Link>
            </p>
          </>
        )}
      </div>
    </AuthChrome>
  );
}
