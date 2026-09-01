import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BiometricPayload } from "@trustid/sdk";
import { useTrustIdAuth as useTrustIdSession } from "../context/TrustIdAuthProvider.js";
import {
  clearStaleAuthCaches,
  clearSilentAutoLoginAttempt,
  executeSilentWebLoginOnce,
  resetSilentWebLoginInflight,
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
  /**
   * Identity-first path: capture face/fingerprint embedding on any terminal.
   * When provided, cloud 1:N match runs before local WebAuthn fallback.
   */
  captureBiometric?: () => Promise<BiometricPayload | null>;
  /** Hardware fingerprint for Master Device tier evaluation */
  getDeviceFingerprint?: () => Promise<string | undefined>;
};

export type UseTrustIdAuthResult = {
  phase: TrustIdAuthPhase;
  /** Alias used by callers / docs (`authState`). */
  authState: TrustIdAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  /** Create a new Trust ID with a single biometric enrollment. */
  createAccount: () => Promise<void>;
  /** Re-run the silent probe. */
  retryProbe: () => void;
};

function failureMessage(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message || err.name;
  return String(err ?? "Authentication failed");
}

/**
 * Implicit authentication + onboarding engine.
 *
 * Mount ? cloud 1:N biometric identify (preferred) OR WebAuthn passkey fallback
 * OR transition to NEEDS_ACCOUNT for Create Trust ID.
 *
 * Missing/deleted passkeys, NotAllowedError, InvalidStateError, cancel, and
 * timeouts always clear stale caches and land on NEEDS_ACCOUNT ù never spin forever.
 */
export function useTrustIdAuth(
  options: UseTrustIdAuthOptions,
): UseTrustIdAuthResult {
  const {
    getInstallId,
    enabled = true,
    onAuthenticated,
    captureBiometric,
    getDeviceFingerprint,
  } = options;
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

  const goNeedsAccount = useCallback(() => {
    clearStaleAuthCaches();
    setIdentity(null);
    setError(null);
    setPhase("NEEDS_ACCOUNT");
  }, [setIdentity]);

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
    resetSilentWebLoginInflight();

    void (async () => {
      setPhase("PROMPTING_BIOMETRIC");
      try {
        if (captureBiometric) {
          const payload = await captureBiometric();
          if (cancelled) return;
          if (payload) {
            const fp = getDeviceFingerprint
              ? await getDeviceFingerprint()
              : undefined;
            const cloud = await apiFetch<{
              matched: boolean;
              identity?: TrustIdIdentity;
            }>("/v1/trust-id/verify-biometric", {
              method: "POST",
              body: JSON.stringify({
                biometric: {
                  ...payload,
                  deviceFingerprint: fp ?? payload.deviceFingerprint,
                },
              }),
            });
            if (cloud.matched && cloud.identity) {
              setIdentity(cloud.identity);
              await refresh();
              if (cancelled) return;
              setPhase("AUTHENTICATED");
              onAuthenticated?.(cloud.identity);
              return;
            }
          }
        }

        const result = await executeSilentWebLoginOnce(apiFetch);
        if (cancelled) return;
        if (result?.identity) {
          setIdentity(result.identity);
          await refresh();
          if (cancelled) return;
          setPhase("AUTHENTICATED");
          onAuthenticated?.(result.identity);
          return;
        }
        goNeedsAccount();
      } catch {
        if (cancelled) return;
        goNeedsAccount();
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

      if (captureBiometric) {
        const payload = await captureBiometric();
        if (payload) {
          await apiFetch("/v1/trust-id/enroll-biometric", {
            method: "POST",
            body: JSON.stringify({ biometric: payload }),
          });
        }
      }

      setPhase("AUTHENTICATED");
      onAuthenticated?.(completed.identity);
    } catch (e) {
      const msg = failureMessage(e);
      const cancelled = /not allowed|abort|cancel|NotAllowedError|AbortError/i.test(
        msg,
      );
      setError(cancelled ? null : msg);
      setPhase("NEEDS_ACCOUNT");
    }
  }, [apiFetch, captureBiometric, getInstallId, onAuthenticated, refresh, setIdentity]);

  const retryProbe = useCallback(() => {
    startedRef.current = false;
    clearStaleAuthCaches();
    setNonce((n) => n + 1);
  }, []);

  const resolved: TrustIdAuthPhase = identity ? "AUTHENTICATED" : phase;

  return {
    phase: resolved,
    authState: resolved,
    identity,
    error,
    createAccount,
    retryProbe,
  };
}
