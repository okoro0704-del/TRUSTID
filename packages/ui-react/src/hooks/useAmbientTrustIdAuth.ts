import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTrustIdSdk,
  type AmbientSignInResult,
  type CaptureHandlers,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import { resolveGuestRealtimeUrl } from "../api/client.js";
import { useTrustIdAuth as useTrustIdSession } from "../context/TrustIdAuthProvider.js";
import { clearStaleAuthCaches } from "../lib/silentAuth.js";
import type { TrustIdIdentity } from "../types.js";

export type AmbientAuthPhase =
  | "CHECKING"
  | "PROMPTING"
  | "OFFER_CREATE"
  | "ENROLLING"
  | "SWITCH_ACCOUNT"
  | "NEEDS_APPROVAL"
  | "AUTHENTICATED"
  | "ERROR";

export type UseAmbientTrustIdAuthOptions = CaptureHandlers & {
  enabled?: boolean;
  apiBaseUrl?: string;
  getInstallId?: () => Promise<string>;
  /**
   * When true, boot may auto-create without consent (legacy).
   * Default false — NOT_FOUND shows an explicit create prompt first.
   */
  allowAutoEnroll?: boolean;
  getLastTrustId?: () => string | null;
  capturePayload?: () => Promise<MultiModalBiometricPayload>;
  onAuthenticated?: (identity: TrustIdIdentity) => void;
  onNeedsApproval?: (info: {
    trustId: string;
    pollToken: string;
    requestId?: string;
  }) => void;
  registerFingerprintBackup?: () => Promise<void | boolean>;
};

export type UseAmbientTrustIdAuthResult = {
  phase: AmbientAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  lastResult: AmbientSignInResult | null;
  previousTrustId: string | null;
  approvalPollToken: string | null;
  retry: () => void;
  confirmSwitchAccount: () => void;
  /** User accepted "create new Trust ID" after NOT_FOUND lookup */
  confirmCreateAccount: () => void;
  /** User declined create prompt */
  declineCreateAccount: () => void;
  continueAfterApproval: () => void;
};

/**
 * Identity-first ambient auth — lookup on boot, enroll only after explicit consent.
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
    allowAutoEnroll = false,
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
  const pendingPayloadRef = useRef<MultiModalBiometricPayload | null>(null);
  const pendingInstallRef = useRef<string | undefined>(undefined);

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
            /* optional */
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
    pendingPayloadRef.current = null;
    // Do not clear remembered account on every boot probe — only on logout.

    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const installId = getInstallId ? await getInstallId() : undefined;
    pendingInstallRef.current = installId;

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

    pendingPayloadRef.current = payload;

    // Lookup-only first — never writes a new Trust ID until user consents.
    const lookup = await sdk.faceLookup({
      face: payload.face,
      installId,
      deviceFingerprint: payload.deviceFingerprint,
    });

    if (lookup.status === "NOT_FOUND") {
      if (allowAutoEnroll) {
        const result = await sdk.ambientAuthenticate({
          captureFace,
          captureFingerprint,
          getDeviceFingerprint,
          payload,
          allowAutoEnroll: true,
          installId,
        });
        setLastResult(result);
        await applyMatchedResult(result);
        return;
      }
      setPhase("OFFER_CREATE");
      return;
    }

    if (lookup.status === "PENDING_MASTER_APPROVAL") {
      const result: AmbientSignInResult = {
        matched: true,
        trustId: lookup.trustId,
        needsMasterApproval: true,
        approvalPollToken: lookup.approvalPollToken,
        approvalRequestId: lookup.approvalRequestId,
        identity: lookup.identity,
      };
      setLastResult(result);
      await applyMatchedResult(result);
      return;
    }

    // MATCH_FOUND
    const result: AmbientSignInResult = {
      matched: true,
      trustId: lookup.trustId ?? lookup.user?.trustId,
      identity: lookup.identity,
      sessionToken: lookup.sessionToken ?? lookup.token,
      isMasterDevice: lookup.isMasterDevice,
    };
    setLastResult(result);

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

  const confirmCreateAccount = useCallback(() => {
    const payload = pendingPayloadRef.current;
    if (!payload?.face) {
      startedRef.current = false;
      setNonce((n) => n + 1);
      return;
    }
    setPhase("ENROLLING");
    setError(null);
    void (async () => {
      const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
      const result = await sdk.ambientAuthenticate({
        captureFace,
        captureFingerprint,
        getDeviceFingerprint,
        payload,
        allowAutoEnroll: true,
        installId: pendingInstallRef.current,
      });
      setLastResult(result);
      await applyMatchedResult(result);
    })().catch((e) => {
      setError(e instanceof Error ? e.message : "Could not create Trust ID");
      setPhase("ERROR");
    });
  }, [
    apiBaseUrl,
    applyMatchedResult,
    captureFace,
    captureFingerprint,
    getDeviceFingerprint,
  ]);

  const declineCreateAccount = useCallback(() => {
    pendingPayloadRef.current = null;
    setError("No Trust ID was created. Scan again when you are ready.");
    setPhase("ERROR");
  }, []);

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

    if (phase === "AUTHENTICATED") {
      setPhase("PROMPTING");
      startedRef.current = false;
    }

    if (startedRef.current && nonce === 0) return;
    startedRef.current = true;

    const t = window.setTimeout(() => {
      void runAmbient().catch((e) => {
        setError(e instanceof Error ? e.message : "Ambient auth failed");
        setPhase("ERROR");
      });
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading, identity, nonce]);

  useEffect(() => {
    if (phase !== "NEEDS_APPROVAL" || !approvalPollToken) return;
    pollAbortRef.current = false;
    let timer: number | undefined;
    let guestWs: WebSocket | null = null;

    const claimNow = async () => {
      if (pollAbortRef.current) return;
      try {
        const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
        const claim = await sdk.claimDeviceApproval(approvalPollToken);
        if (claim.identity) {
          await finishAuthenticated(claim.identity as TrustIdIdentity);
          return;
        }
        if (claim.sessionToken || claim.mode === "ambient" || claim.mode === "temporary") {
          await finishAuthenticated();
        }
      } catch {
        /* keep waiting */
      }
    };

    const tick = async () => {
      if (pollAbortRef.current) return;
      try {
        const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
        const poll = await sdk.pollDeviceApproval(approvalPollToken);
        if (pollAbortRef.current) return;
        if (poll.status === "approved" || poll.status === "temporary") {
          await claimNow();
          return;
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

    if (typeof WebSocket !== "undefined") {
      try {
        guestWs = new WebSocket(
          resolveGuestRealtimeUrl(apiBaseUrl, approvalPollToken),
        );
        guestWs.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as {
              type?: string;
              status?: string;
            };
            if (
              msg.type === "LOGIN_APPROVAL_RESULT" ||
              msg.type === "approval.resolved"
            ) {
              if (
                msg.status === "REJECTED" ||
                msg.status === "declined" ||
                msg.status === "expired"
              ) {
                setError("Access was denied on your Master Device.");
                setPhase("ERROR");
                return;
              }
              void claimNow();
            }
          } catch {
            /* ignore */
          }
        };
      } catch {
        /* optional */
      }
    }

    timer = window.setTimeout(tick, 2000);
    return () => {
      pollAbortRef.current = true;
      if (timer) window.clearTimeout(timer);
      guestWs?.close();
    };
  }, [phase, approvalPollToken, apiBaseUrl, finishAuthenticated]);

  const retry = useCallback(() => {
    startedRef.current = false;
    pendingResultRef.current = null;
    pendingPayloadRef.current = null;
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
    confirmCreateAccount,
    declineCreateAccount,
    continueAfterApproval: () => {
      void continueAfterApproval();
    },
  };
}
