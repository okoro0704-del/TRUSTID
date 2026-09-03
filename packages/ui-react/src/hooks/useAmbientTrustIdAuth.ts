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
  | "SWITCH_ACCOUNT"
  | "NEEDS_APPROVAL"
  | "AUTHENTICATED"
  | "ERROR";

export type UseAmbientTrustIdAuthOptions = CaptureHandlers & {
  enabled?: boolean;
  apiBaseUrl?: string;
  getInstallId?: () => Promise<string>;
  allowAutoEnroll?: boolean;
  /** Last Trust ID that used this device (local memory only). */
  getLastTrustId?: () => string | null;
  /** Pre-built multi-modal payload (cloud biometric only ? no device passkey probe) */
  capturePayload?: () => Promise<MultiModalBiometricPayload>;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
  onNeedsApproval?: (info: {
    trustId: string;
    pollToken: string;
    requestId?: string;
  }) => void;
  /**
   * After first face enroll (or when session opens without a fingerprint template),
   * capture and register a fingerprint backup to the cloud registry.
   */
  registerFingerprintBackup?: () => Promise<void | boolean>;
};

export type UseAmbientTrustIdAuthResult = {
  phase: AmbientAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  lastResult: AmbientSignInResult | null;
  /** Previous local Trust ID when switching accounts */
  previousTrustId: string | null;
  approvalPollToken: string | null;
  retry: () => void;
  /** User confirms login as a different face than the last local user */
  confirmSwitchAccount: () => void;
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
    getLastTrustId,
    onAuthenticated,
    onNeedsApproval,
    allowAutoEnroll = true,
    captureFace,
    captureFingerprint,
    getDeviceFingerprint,
    capturePayload,
    registerFingerprintBackup,
  } = options;

  const { loading, identity, setIdentity, refresh } = useTrustIdSession();
  const [phase, setPhase] = useState<AmbientAuthPhase>("CHECKING");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AmbientSignInResult | null>(null);
  const [previousTrustId, setPreviousTrustId] = useState<string | null>(null);
  const [approvalPollToken, setApprovalPollToken] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);
  const pollAbortRef = useRef(false);
  const pendingResultRef = useRef<AmbientSignInResult | null>(null);

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

  const applyMatchedResult = useCallback(
    async (result: AmbientSignInResult) => {
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

      if (result.matched && (result.identity || result.sessionToken)) {
        if (result.enrolled && registerFingerprintBackup) {
          try {
            await registerFingerprintBackup();
          } catch {
            /* fingerprint backup is optional ? face alone still works */
          }
        }
        if (result.identity) {
          await finishAuthenticated(result.identity as TrustIdIdentity);
          return;
        }
        await finishAuthenticated();
        return;
      }

      setError(result.error ?? "Biometric recognition failed");
      setPhase("ERROR");
    },
    [finishAuthenticated, onNeedsApproval, registerFingerprintBackup],
  );

  const runAmbient = useCallback(async () => {
    setPhase("PROMPTING");
    setError(null);
    setApprovalPollToken(null);
    setPreviousTrustId(null);
    pendingResultRef.current = null;
    clearStaleAuthCaches();

    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const installId = getInstallId ? await getInstallId() : undefined;

    let payload: MultiModalBiometricPayload | undefined;
    try {
      payload = capturePayload ? await capturePayload() : undefined;
    } catch {
      payload = undefined;
    }

    if (!payload?.face) {
      setError(
        "No face detected. Look straight at the camera so Trust ID can verify you.",
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

    if (!result.matched && result.error) {
      setError(result.error);
      setPhase("ERROR");
      return;
    }

    const lastLocal = getLastTrustId?.() ?? null;
    if (
      result.matched &&
      result.trustId &&
      lastLocal &&
      lastLocal !== result.trustId
    ) {
      pendingResultRef.current = result;
      setPreviousTrustId(lastLocal);
      setPhase("SWITCH_ACCOUNT");
      return;
    }

    await applyMatchedResult(result);
  }, [
    allowAutoEnroll,
    apiBaseUrl,
    applyMatchedResult,
    captureFace,
    captureFingerprint,
    capturePayload,
    getDeviceFingerprint,
    getInstallId,
    getLastTrustId,
  ]);

  const confirmSwitchAccount = useCallback(() => {
    const pending = pendingResultRef.current;
    if (!pending) {
      startedRef.current = false;
      setNonce((n) => n + 1);
      return;
    }
    pendingResultRef.current = null;
    void applyMatchedResult(pending);
  }, [applyMatchedResult]);

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

    // After logout identity is null ? clear stale AUTHENTICATED and re-run cloud match.
    if (phase === "AUTHENTICATED") {
      setPhase("PROMPTING");
      startedRef.current = false;
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
    pendingResultRef.current = null;
    clearStaleAuthCaches();
    setNonce((n) => n + 1);
  }, []);

  return {
    phase: identity ? "AUTHENTICATED" : phase,
    identity,
    error,
    lastResult,
    previousTrustId,
    approvalPollToken,
    retry,
    confirmSwitchAccount,
    continueAfterApproval: () => {
      void continueAfterApproval();
    },
  };
}
