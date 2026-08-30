import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTrustIdAuth as useTrustIdSession } from "../context/TrustIdAuthProvider.js";
import {
  clearSilentAutoLoginAttempt,
  executeSilentWebLoginOnce,
} from "../lib/silentAuth.js";
import type { TrustIdIdentity } from "../types.js";

export type TrustIdAuthPhase =
  | "CHECKING"
  | "PROMPTING_BIOMETRIC"
  | "AUTHENTICATED"
  | "NEEDS_ACCOUNT"
  | "CREATING_ACCOUNT"
  | "ERROR";

export type UseTrustIdAuthOptions = {
  /** Stable device install id (required for silent registration). */
  getInstallId: () => Promise<string>;
  enabled?: boolean;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
};

export type UseTrustIdAuthResult = {
  phase: TrustIdAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  /** Create a new Trust ID with a single biometric enrollment. */
  createAccount: () => Promise<void>;
  /** Re-run the silent probe. */
  retryProbe: () => void;
};

function isNoCredentialFailure(message: string): boolean {
  return /not allowed|abort|cancel|no credentials|timed out|timeout|unknown credential|invalid state|not supported/i.test(
    message,
  );
}

/**
 * Implicit authentication + onboarding engine.
 *
 * Mount ? probe WebAuthn / passkey storage ? biometric unlock
 * OR transition to NEEDS_ACCOUNT for Create Trust ID.
 *
 * Note: session accessors remain on `useTrustIdSession` / `useAuth` from the provider.
 * This hook is the smart entry state machine requested as `useTrustIdAuth`.
 */
export function useTrustIdAuth(
  options: UseTrustIdAuthOptions,
): UseTrustIdAuthResult {
  const { getInstallId, enabled = true, onAuthenticated } = options;
  const {
    loading,
    identity,
    setIdentity,
    apiFetch,
    refresh,
  } = useTrustIdSession();

  const [phase, setPhase] = useState<TrustIdAuthPhase>("CHECKING");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    if (loading) {
      setPhase("CHECKING");
      return;
    }

    if (identity) {
      setPhase("AUTHENTICATED");
      return;
    }

    if (startedRef.current && nonce === 0) return;
    startedRef.current = true;

    let cancelled = false;
    setPhase("CHECKING");
    setError(null);
    clearSilentAutoLoginAttempt();

    void (async () => {
      setPhase("PROMPTING_BIOMETRIC");
      try {
        const result = await executeSilentWebLoginOnce(apiFetch);
        if (cancelled) return;
        if (result.identity) {
          setIdentity(result.identity);
          await refresh();
          setPhase("AUTHENTICATED");
          onAuthenticated?.(result.identity);
          return;
        }
        setPhase("NEEDS_ACCOUNT");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Authentication failed";
        if (isNoCredentialFailure(msg)) {
          setPhase("NEEDS_ACCOUNT");
          setError(null);
        } else {
          setPhase("ERROR");
          setError(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading, identity, nonce]);

  const createAccount = useCallback(async () => {
    setError(null);
    setPhase("CREATING_ACCOUNT");
    try {
      const installId = await getInstallId();
      const began = await apiFetch<{
        userId: string;
        trustId: string;
        options: Parameters<typeof startRegistration>[0]["optionsJSON"] & {
          challengeId?: string;
          purpose?: string;
        };
      }>("/v1/auth/register-silent/options", {
        method: "POST",
        body: JSON.stringify({ installId }),
      });

      const { challengeId: _c, purpose: _p, ...optionsJSON } = began.options;
      void _c;
      void _p;

      const attestation = await startRegistration({ optionsJSON });

      const completed = await apiFetch<{
        identity: TrustIdIdentity;
        trustId: string;
      }>("/v1/auth/register-silent", {
        method: "POST",
        body: JSON.stringify({
          userId: began.userId,
          installId,
          response: attestation,
        }),
      });

      setIdentity(completed.identity);
      await refresh();
      setPhase("AUTHENTICATED");
      onAuthenticated?.(completed.identity);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create Trust ID";
      const cancelled = /not allowed|abort|cancel/i.test(msg);
      setError(cancelled ? null : msg);
      setPhase("NEEDS_ACCOUNT");
    }
  }, [apiFetch, getInstallId, onAuthenticated, refresh, setIdentity]);

  const retryProbe = useCallback(() => {
    startedRef.current = false;
    clearSilentAutoLoginAttempt();
    setNonce((n) => n + 1);
  }, []);

  return {
    phase: identity ? "AUTHENTICATED" : phase,
    identity,
    error,
    createAccount,
    retryProbe,
  };
}
