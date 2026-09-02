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
  | "NEEDS_APPROVAL"
  | "AUTHENTICATED"
  | "ERROR";

export type UseAmbientTrustIdAuthOptions = CaptureHandlers & {
  enabled?: boolean;
  apiBaseUrl?: string;
  getInstallId?: () => Promise<string>;
  allowAutoEnroll?: boolean;
  /** Pre-built multi-modal payload (cloud biometric only ? no device passkey probe) */
  capturePayload?: () => Promise<MultiModalBiometricPayload>;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
  onNeedsApproval?: (info: {
    trustId: string;
    pollToken: string;
    requestId?: string;
  }) => void;
};

export type UseAmbientTrustIdAuthResult = {
  phase: AmbientAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  lastResult: AmbientSignInResult | null;
  approvalPollToken: string | null;
  retry: () => void;
  /** Poll + claim master approval without re-running face capture */
  continueAfterApproval: () => void;
};

/**
 * Identity-first ambient auth ? cloud biometric match before any device key.
 * Does not probe local passkeys on boot.
 */
export function useAmbientTrustIdAuth(
  options: UseAmbientTrustIdAuthOptions = {},
): UseAmbientTrustIdAuthResult {
  const {
    enabled = true,
    apiBaseUrl = "/api",
    getInstallId,
    onAuthenticated,
    onNeedsApproval,
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
  const [approvalPollToken, setApprovalPollToken] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);
  const pollAbortRef = useRef(false);

  const finishAuthenticated = useCallback(
    async (id?: TrustIdIdentity | null) => {
      if (id) {
        setIdentity(id);
        onAuthenticated?.(id);
      }
      await refresh();
      setPhase("AUTHENTICATED");
    },
    [onAuthenticated, refresh, setIdentity],
  );

  const runAmbient = useCallback(async () => {
    setPhase("PROMPTING");
    setError(null);
    setApprovalPollToken(null);
    clearStaleAuthCaches();

    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const installId = getInstallId ? await getInstallId() : undefined;

    let payload: MultiModalBiometricPayload | undefined;
    try {
      payload = capturePayload ? await capturePayload() : undefined;
    } catch {
      payload = undefined;
    }

    if (!payload?.face && !payload?.fingerprint && !captureFace && !captureFingerprint) {
      setError(
        "Allow camera access so Trust ID can verify your face against the cloud registry.",
      );
      setPhase("ERROR");
      return;
    }

    const result = await sdk.ambientAuthenticate({
      captureFace,
      captureFingerprint,
      getDeviceFingerprint,
      payload,
      allowAutoEnroll,
      installId,
    });

    setLastResult(result);

    if (result.needsMasterApproval && result.approvalPollToken && result.trustId) {
      setApprovalPollToken(result.approvalPollToken);
      setPhase("NEEDS_APPROVAL");
      onNeedsApproval?.({
        trustId: result.trustId,
        pollToken: result.approvalPollToken,
        requestId: result.approvalRequestId,
      });
      return;
    }

    if (result.enrolled) setPhase("ENROLLING");

    if (result.matched && result.identity) {
      await finishAuthenticated(result.identity as TrustIdIdentity);
      return;
    }

    if (result.matched && result.sessionToken) {
      await finishAuthenticated();
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
    finishAuthenticated,
    getDeviceFingerprint,
    getInstallId,
    onNeedsApproval,
  ]);

  const continueAfterApproval = useCallback(async () => {
    const token = approvalPollToken;
    if (!token) {
      startedRef.current = false;
      setNonce((n) => n + 1);
      return;
    }

    setError(null);
    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    try {
      const poll = await sdk.pollDeviceApproval(token);
      if (poll.status === "declined" || poll.status === "expired") {
        setError(
          poll.message ??
            (poll.status === "declined"
              ? "Access was denied on your Master Device."
              : "Approval request expired. Try again."),
        );
        setPhase("ERROR");
        return;
      }
      if (poll.status !== "approved" && poll.status !== "temporary") {
        setError("Still waiting for your Master Device to approve this terminal.");
        setPhase("NEEDS_APPROVAL");
        return;
      }

      const claim = await sdk.claimDeviceApproval(token);
      if (claim.identity) {
        await finishAuthenticated(claim.identity as TrustIdIdentity);
        return;
      }
      if (claim.sessionToken || claim.mode === "ambient" || claim.mode === "temporary") {
        await finishAuthenticated();
        return;
      }
      setError("Approval completed but session could not be established.");
      setPhase("ERROR");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not claim approval");
      setPhase("NEEDS_APPROVAL");
    }
  }, [apiBaseUrl, approvalPollToken, finishAuthenticated]);

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

    // Brief delay so Android WebView / permissions settle before camera.
    const t = window.setTimeout(() => {
      void runAmbient().catch((e) => {
        setError(e instanceof Error ? e.message : "Ambient auth failed");
        setPhase("ERROR");
      });
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading, identity, nonce]);

  // Auto-poll while waiting for master approval
  useEffect(() => {
    if (phase !== "NEEDS_APPROVAL" || !approvalPollToken) return;
    pollAbortRef.current = false;
    let timer: number | undefined;

    const tick = async () => {
      if (pollAbortRef.current) return;
      try {
        const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
        const poll = await sdk.pollDeviceApproval(approvalPollToken);
        if (pollAbortRef.current) return;
        if (poll.status === "approved" || poll.status === "temporary") {
          const claim = await sdk.claimDeviceApproval(approvalPollToken);
          if (claim.identity) {
            await finishAuthenticated(claim.identity as TrustIdIdentity);
            return;
          }
          if (claim.sessionToken || claim.mode === "ambient" || claim.mode === "temporary") {
            await finishAuthenticated();
            return;
          }
        }
        if (poll.status === "declined" || poll.status === "expired") {
          setError(
            poll.message ??
              (poll.status === "declined"
                ? "Access was denied on your Master Device."
                : "Approval request expired. Try again."),
          );
          setPhase("ERROR");
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!pollAbortRef.current) {
        timer = window.setTimeout(tick, 2500);
      }
    };

    timer = window.setTimeout(tick, 2000);
    return () => {
      pollAbortRef.current = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [phase, approvalPollToken, apiBaseUrl, finishAuthenticated]);

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
    approvalPollToken,
    retry,
    continueAfterApproval: () => {
      void continueAfterApproval();
    },
  };
}
