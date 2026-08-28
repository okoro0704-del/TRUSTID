import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";
import { useTrustIdAuth } from "../context/TrustIdAuthProvider.js";

export type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

export type LoginHints = {
  email?: string;
  phone?: string;
  trustId?: string;
};

type CacheEntry = {
  key: string;
  options: AuthOptions;
  fetchedAt: number;
};

const MAX_AGE_MS = 90_000;

function hintsKey(hints: LoginHints) {
  return [
    hints.trustId?.trim() ?? "",
    hints.email?.trim().toLowerCase() ?? "",
    hints.phone?.trim() ?? "",
  ].join("|");
}

function cleanHints(hints: LoginHints = {}): LoginHints {
  return {
    email: hints.email?.trim() || undefined,
    phone: hints.phone?.trim() || undefined,
    trustId: hints.trustId?.trim() || undefined,
  };
}

function stripServerExtras(
  raw: AuthOptions & { challengeId?: string; purpose?: string },
): AuthOptions {
  const { challengeId: _c, purpose: _p, ...optionsJSON } = raw;
  void _c;
  void _p;
  return optionsJSON;
}

export function createLoginOptionsCache(apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>) {
  let entry: CacheEntry | null = null;
  let inflight: Promise<AuthOptions> | null = null;
  let inflightKey = "";

  async function fetchOptions(hints: LoginHints = {}): Promise<AuthOptions> {
    const cleaned = cleanHints(hints);
    const raw = await apiFetch<AuthOptions & { challengeId?: string; purpose?: string }>(
      "/auth/webauthn/login/options",
      {
        method: "POST",
        body: JSON.stringify({
          trustId: cleaned.trustId,
          email: cleaned.email,
          phone: cleaned.phone,
        }),
      },
    );
    return stripServerExtras(raw);
  }

  function peek(hints: LoginHints = {}): AuthOptions | null {
    if (!entry) return null;
    if (entry.key !== hintsKey(cleanHints(hints))) return null;
    if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return null;
    return entry.options;
  }

  async function prefetch(hints: LoginHints = {}): Promise<void> {
    const cleaned = cleanHints(hints);
    const key = hintsKey(cleaned);
    if (peek(cleaned)) return;
    if (inflight && inflightKey === key) {
      await inflight.catch(() => undefined);
      return;
    }
    inflightKey = key;
    inflight = fetchOptions(cleaned)
      .then((options) => {
        entry = { key, options, fetchedAt: Date.now() };
        return options;
      })
      .finally(() => {
        inflight = null;
        inflightKey = "";
      });
    await inflight.catch(() => undefined);
  }

  async function take(hints: LoginHints = {}): Promise<AuthOptions> {
    const cleaned = cleanHints(hints);
    const key = hintsKey(cleaned);
    const cached = peek(cleaned);
    if (cached) {
      entry = null;
      return cached;
    }
    if (inflight && inflightKey === key) {
      const options = await inflight;
      entry = null;
      return options;
    }
    const options = await fetchOptions(cleaned);
    entry = null;
    return options;
  }

  function invalidate() {
    entry = null;
    inflight = null;
    inflightKey = "";
  }

  return { prefetch, take, invalidate, peek };
}

export async function runPasskeyLogin(optionsJSON: AuthOptions) {
  return startAuthentication({ optionsJSON });
}

export type TrustIdLoginButtonProps = {
  hints?: LoginHints;
  label?: string;
  className?: string;
  onSuccess?: () => void;
  onError?: (message: string) => void;
};

export function TrustIdLoginButton({
  hints = {},
  label = "Sign in with passkey",
  className = "tid-btn tid-btn-primary",
  onSuccess,
  onError,
}: TrustIdLoginButtonProps) {
  const { refresh, setIdentity, apiFetch } = useTrustIdAuth();
  const cacheRef = useRef(createLoginOptionsCache(apiFetch));
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"passkey" | "oob">("passkey");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oobUrl, setOobUrl] = useState<string | null>(null);
  const [oobStatus, setOobStatus] = useState<string | null>(null);

  useEffect(() => {
    if (open && mode === "passkey") {
      cacheRef.current.prefetch(hints).catch(() => undefined);
    }
  }, [open, mode, hints]);

  async function onPasskeyLogin() {
    setBusy(true);
    setError(null);
    try {
      const options = await cacheRef.current.take(hints);
      const assertion = await runPasskeyLogin(options);
      const data = await apiFetch<{ identity: import("../types.js").TrustIdIdentity }>(
        "/auth/webauthn/login/verify",
        {
          method: "POST",
          body: JSON.stringify(assertion),
        },
      );
      setIdentity(data.identity);
      await refresh();
      setOpen(false);
      onSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      setError(msg);
      onError?.(msg);
    } finally {
      setBusy(false);
    }
  }

  async function startOob() {
    setBusy(true);
    setError(null);
    setOobStatus(null);
    try {
      const created = await apiFetch<{ pollToken: string; id: string }>(
        "/device-approvals",
        {
          method: "POST",
          body: JSON.stringify({
            deviceName: "Web browser (OOB)",
            platform: "web",
          }),
        },
      );
      const url = `${window.location.origin}/waiting-approval?token=${encodeURIComponent(created.pollToken)}`;
      setOobUrl(url);
      setMode("oob");
      pollOob(created.pollToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "OOB setup failed";
      setError(msg);
      onError?.(msg);
    } finally {
      setBusy(false);
    }
  }

  function pollOob(token: string) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const poll = await apiFetch<{
          status: string;
          approved?: boolean;
        }>(`/device-approvals/poll/${encodeURIComponent(token)}`);
        setOobStatus(`Status: ${poll.status}`);
        if (poll.status === "approved" || poll.status === "temporary") {
          const claim = await apiFetch<{ identity: import("../types.js").TrustIdIdentity }>(
            "/device-approvals/claim",
            {
              method: "POST",
              body: JSON.stringify({ pollToken: token }),
            },
          );
          setIdentity(claim.identity);
          await refresh();
          setOpen(false);
          onSuccess?.();
          stopped = true;
          return;
        }
        if (poll.status === "declined" || poll.status === "expired") {
          setError(`Approval ${poll.status}`);
          stopped = true;
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!stopped) setTimeout(tick, 2500);
    };
    tick();
  }

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          setOpen(true);
          setMode("passkey");
          setError(null);
        }}
      >
        {label}
      </button>

      {open && (
        <div className="tid-modal-backdrop" role="dialog" aria-modal="true">
          <div className="tid-modal">
            <h2>TrustID Sign In</h2>
            {mode === "passkey" ? (
              <>
                <p className="tid-muted">
                  Use your device passkey (Face ID, Touch ID, or security key).
                </p>
                {error && <p className="tid-error">{error}</p>}
                <div className="tid-actions">
                  <button
                    type="button"
                    className="tid-btn tid-btn-primary"
                    disabled={busy}
                    onClick={onPasskeyLogin}
                  >
                    {busy ? "Waitingù" : "Continue with passkey"}
                  </button>
                  <button
                    type="button"
                    className="tid-btn tid-btn-ghost"
                    disabled={busy}
                    onClick={startOob}
                  >
                    Sign in on another device
                  </button>
                  <button
                    type="button"
                    className="tid-btn tid-btn-ghost"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="tid-muted">
                  Scan this QR on your trusted device, or open the link to approve sign-in.
                </p>
                {oobUrl && (
                  <div className="tid-qr-block">
                    <img
                      className="tid-qr"
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(oobUrl)}`}
                      alt="OOB pairing QR code"
                      width={180}
                      height={180}
                    />
                    <code className="tid-code">{oobUrl}</code>
                  </div>
                )}
                {oobStatus && <p className="tid-muted">{oobStatus}</p>}
                {error && <p className="tid-error">{error}</p>}
                <div className="tid-actions">
                  <button
                    type="button"
                    className="tid-btn tid-btn-ghost"
                    onClick={() => setMode("passkey")}
                  >
                    Back to passkey
                  </button>
                  <button
                    type="button"
                    className="tid-btn tid-btn-ghost"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
