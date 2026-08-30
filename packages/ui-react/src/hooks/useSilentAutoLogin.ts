import { useEffect, useRef, useState } from "react";
import { useTrustIdAuth } from "../context/TrustIdAuthProvider.js";
import {
  clearSilentAutoLoginAttempt,
  executeSilentWebLoginOnce,
  hasAttemptedSilentAutoLogin,
  markSilentAutoLoginAttempted,
} from "../lib/silentAuth.js";

export type SilentAutoLoginStatus =
  | "idle"
  | "waiting_session"
  | "prompting"
  | "success"
  | "skipped"
  | "error";

export type UseSilentAutoLoginOptions = {
  /** When false, the hook does nothing. Default true. */
  enabled?: boolean;
  /** Only attempt once per browser tab session. Default true. */
  oncePerSession?: boolean;
  /** Skip when an identity is already present. Default true. */
  skipIfAuthenticated?: boolean;
  /** Wait for provider session probe to finish before prompting. Default true. */
  waitForSessionProbe?: boolean;
  onSuccess?: () => void;
  onError?: (message: string) => void;
  onSkipped?: (reason: string) => void;
};

export type UseSilentAutoLoginResult = {
  status: SilentAutoLoginStatus;
  error: string | null;
  prompting: boolean;
  /** Manually re-run (clears once-per-session latch). */
  retry: () => void;
};

/**
 * Instant PWA WebAuthn trigger — runs on mount with zero user input.
 * Fetches a backend challenge, invokes the OS authenticator via
 * `mediation: 'optional'` (then conditional / direct), and posts to
 * `POST /v1/auth/silent-assert` to resolve $TID + session.
 */
export function useSilentAutoLogin(
  options: UseSilentAutoLoginOptions = {},
): UseSilentAutoLoginResult {
  const {
    enabled = true,
    oncePerSession = true,
    skipIfAuthenticated = true,
    waitForSessionProbe = true,
    onSuccess,
    onError,
    onSkipped,
  } = options;

  const { loading, identity, setIdentity, apiFetch, refresh } = useTrustIdAuth();
  const [status, setStatus] = useState<SilentAutoLoginStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setStatus("skipped");
      onSkipped?.("disabled");
      return;
    }

    if (waitForSessionProbe && loading) {
      setStatus("waiting_session");
      return;
    }

    if (skipIfAuthenticated && identity) {
      setStatus("success");
      return;
    }

    if (oncePerSession && hasAttemptedSilentAutoLogin() && nonce === 0) {
      setStatus("skipped");
      onSkipped?.("already_attempted");
      return;
    }

    if (startedRef.current && nonce === 0) return;
    startedRef.current = true;

    let cancelled = false;
    setStatus("prompting");
    setError(null);
    markSilentAutoLoginAttempted();

    void (async () => {
      try {
        const result = await executeSilentWebLoginOnce(apiFetch);
        if (cancelled) return;
        if (result.identity) {
          setIdentity(result.identity);
        }
        await refresh();
        if (cancelled) return;
        setStatus("success");
        onSuccess?.();
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Silent login failed";
        // User cancel / no credentials is a soft skip, not a hard error UX.
        const soft =
          /not allowed|abort|cancel|no credentials|timed out|unknown credential/i.test(
            msg,
          );
        setError(soft ? null : msg);
        setStatus(soft ? "skipped" : "error");
        if (soft) onSkipped?.(msg);
        else onError?.(msg);
      }
    })();

    return () => {
      cancelled = true;
    };
    // intentionally re-run when nonce bumps (retry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading, identity, nonce, waitForSessionProbe, skipIfAuthenticated, oncePerSession]);

  function retry() {
    clearSilentAutoLoginAttempt();
    startedRef.current = false;
    setNonce((n) => n + 1);
  }

  return {
    status,
    error,
    prompting: status === "prompting" || status === "waiting_session",
    retry,
  };
}
