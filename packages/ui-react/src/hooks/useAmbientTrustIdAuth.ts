import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTrustIdSdk,
  type AmbientSignInResult,
  type CaptureHandlers,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import { useTrustIdAuth as useTrustIdSession } from "../context/TrustIdAuthProvider.js";
import { clearStaleAuthCaches } from "../lib/silentAuth.js";
import type { TrustIdIdentity } from "../types.js";

export type AmbientAuthPhase =
  | "CHECKING"
  | "PROMPTING"
  | "ENROLLING"
  | "AUTHENTICATED"
  | "ERROR";

export type UseAmbientTrustIdAuthOptions = CaptureHandlers & {
  enabled?: boolean;
  apiBaseUrl?: string;
  getInstallId?: () => Promise<string>;
  allowAutoEnroll?: boolean;
  /** Pre-built multi-modal payload (single WebAuthn prompt on web) */
  capturePayload?: () => Promise<MultiModalBiometricPayload>;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
};

export type UseAmbientTrustIdAuthResult = {
  phase: AmbientAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  lastResult: AmbientSignInResult | null;
  retry: () => void;
};

/**
 * Zero-UI ambient auth ù auto-invokes multi-modal biometric pipeline on mount.
 * No forms, no sign-in buttons, no auth page redirects.
 */
export function useAmbientTrustIdAuth(
  options: UseAmbientTrustIdAuthOptions = {},
): UseAmbientTrustIdAuthResult {
  const {
    enabled = true,
    apiBaseUrl = "/api",
    getInstallId,
    onAuthenticated,
    allowAutoEnroll = true,
    captureFace,
    captureFingerprint,
    getDeviceFingerprint,
    capturePayload,
  } = options;

  const { loading, identity, setIdentity, refresh } = useTrustIdSession();
  const [phase, setPhase] = useState<AmbientAuthPhase>("CHECKING");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AmbientSignInResult | null>(null);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);

  const runAmbient = useCallback(async () => {
    setPhase("PROMPTING");
    setError(null);
    clearStaleAuthCaches();

    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const installId = getInstallId ? await getInstallId() : undefined;

    const result = await sdk.ambientAuthenticate({
      captureFace,
      captureFingerprint,
      getDeviceFingerprint,
      payload: capturePayload ? await capturePayload() : undefined,
      allowAutoEnroll,
      installId,
    });

    setLastResult(result);

    if (result.enrolled) setPhase("ENROLLING");

    if (result.matched && result.identity) {
      setIdentity(result.identity as TrustIdIdentity);
      await refresh();
      setPhase("AUTHENTICATED");
      onAuthenticated?.(result.identity as TrustIdIdentity);
      return;
    }

    if (result.matched) {
      await refresh();
      setPhase("AUTHENTICATED");
      return;
    }

    setError(result.error ?? "Biometric recognition failed");
    setPhase("ERROR");
  }, [
    allowAutoEnroll,
    apiBaseUrl,
    captureFace,
    captureFingerprint,
    capturePayload,
    getDeviceFingerprint,
    getInstallId,
    onAuthenticated,
    refresh,
    setIdentity,
  ]);

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

    void runAmbient().catch((e) => {
      setError(e instanceof Error ? e.message : "Ambient auth failed");
      setPhase("ERROR");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading, identity, nonce]);

  const retry = useCallback(() => {
    startedRef.current = false;
    clearStaleAuthCaches();
    setNonce((n) => n + 1);
  }, []);

  return {
    phase: identity ? "AUTHENTICATED" : phase,
    identity,
    error,
    lastResult,
    retry,
  };
}
