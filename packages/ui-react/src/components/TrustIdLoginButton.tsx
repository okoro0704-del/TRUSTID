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

/**
 * Zero-input discoverable passkey assertion.
 * Prefers conditional mediation (browser autofill) when available; otherwise
 * direct WebAuthn get with empty allowCredentials (resident credentials).
 */
export async function runSilentPasskeyLogin(optionsJSON: AuthOptions) {
  const publicKey: AuthOptions = {
    ...optionsJSON,
    // Ensure discoverable-credential path: no username pre-fill.
    allowCredentials: optionsJSON.allowCredentials?.length
      ? optionsJSON.allowCredentials
      : [],
  };

  try {
    return await startAuthentication({
      optionsJSON: publicKey,
      useBrowserAutofill: true,
    });
  } catch {
    return startAuthentication({ optionsJSON: publicKey });
  }
}

export type TrustIdLoginButtonProps = {
  /** Optional hints ? unused for primary silent login; kept for advanced / fallback flows. */
  hints?: LoginHints;
  label?: string;
  className?: string;
  /** When true (default), Login immediately invokes silent biometric / passkey assert. */
  silent?: boolean;
  onSuccess?: () => void;
  onError?: (message: string) => void;
  /** Called when silent assert reports the device must complete one-time pairing. */
  onDeviceUnpaired?: () => void;
};

export function TrustIdLoginButton({
  hints = {},
  label = "Login",
  className = "tid-btn tid-btn-primary",
  silent = true,
  onSuccess,
  onError,
  onDeviceUnpaired,
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
    // Prefetch discoverable options with zero identity fields.
    cacheRef.current.prefetch({}).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (open && mode === "passkey") {
      cacheRef.current.prefetch(hints).catch(() => undefined);
    }
  }, [open, mode, hints]);

  async function completeSilentWebAuthn() {
    // Zero-input: never send email/phone/trustId for primary login.
    const options = await cacheRef.current.take({});
    const assertion = await runSilentPasskeyLogin(options);
    const data = await apiFetch<{ identity: import("../types.js").TrustIdIdentity }>(
      "/v1/auth/silent-assert",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "webauthn",
          response: assertion,
        }),
      },
    );
    setIdentity(data.identity);
    await refresh();
    onSuccess?.();
  }

  async function onSilentLogin() {
    setBusy(true);
    setError(null);
    try {
      await completeSilentWebAuthn();
      setOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      const unpaired =
        /unpaired|device_unpaired|Unknown credential/i.test(msg);
      if (unpaired) {
        onDeviceUnpaired?.();
        setOpen(true);
        setMode("passkey");
        setError("This device is not paired yet. Complete one-time setup below.");
      } else {
        setError(msg);
        onError?.(msg);
        // Offer fallback modal only when silent path needs recovery options.
        setOpen(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onPasskeyLogin() {
    setBusy(true);
    setError(null);
    try {
      await completeSilentWebAuthn();
      setOpen(false);
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
        disabled={busy}
        onClick={() => {
          setError(null);
          if (silent) {
            void onSilentLogin();
          } else {
            setOpen(true);
            setMode("passkey");
          }
        }}
      >
        {busy ? "Signing in?" : label}
      </button>

      {open && (
        <div className="tid-modal-backdrop" role="dialog" aria-modal="true">
          <div className="tid-modal">
            <h2>TrustID Sign In</h2>
            {mode === "passkey" ? (
              <>
                <p className="tid-muted">
                  Use your device biometric (Face ID, fingerprint, or passkey). No email or phone needed.
                </p>
                {error && <p className="tid-error">{error}</p>}
                <div className="tid-actions">
                  <button
                    type="button"
                    className="tid-btn tid-btn-primary"
                    disabled={busy}
                    onClick={onPasskeyLogin}
                  >
                    {busy ? "Waiting?" : "Continue with biometric"}
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
                    Back to biometric
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
