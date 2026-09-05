import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTrustIdSdk,
  type AmbientSignInResult,
  type CaptureHandlers,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import { resolveGuestRealtimeUrl } from "../api/client.js";
import { useTrustIdAuth as useTrustIdSession } from "../context/TrustIdAuthProvider.js";
import type { TrustIdIdentity } from "../types.js";

export type AmbientAuthPhase =
  | "CHECKING"
  | "PROMPTING"
  | "OFFER_CREATE"
  | "ENROLLING"
  | "DEVICE_SAVED"
  | "OFFER_FINGERPRINT"
  | "SAVING_FINGERPRINT"
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
  /**
   * Capture + enroll fingerprint backup after create.
   * Return true when saved to the cloud registry.
   */
  registerFingerprintBackup?: () => Promise<void | boolean>;
  /** True when this install already owns a Trust ID locally / occupancy cache */
  hasBoundInstall?: () => boolean;
  /** Persist session token to encrypted secure storage after enroll/login */
  storeSessionToken?: (token: string) => Promise<void>;
  /** Optional FCM token for heads-up approval pushes */
  getPushToken?: () => Promise<string | null>;
  /**
   * Persist TRUST_ID_KEY / IS_MASTER_DEVICE / DEVICE_ID immediately after create.
   */
  persistMasterDeviceState?: (info: {
    trustId: string;
    isMasterDevice: boolean;
    deviceId?: string | null;
  }) => Promise<void>;
  /**
   * Prompt native fingerprint / device PIN. Return true when OS auth succeeds.
   * Used when face fails on an already-bound install.
   */
  unlockWithDeviceCredential?: (reason: string) => Promise<boolean>;
};

export type UseAmbientTrustIdAuthResult = {
  phase: AmbientAuthPhase;
  identity: TrustIdIdentity | null;
  error: string | null;
  lastResult: AmbientSignInResult | null;
  previousTrustId: string | null;
  approvalPollToken: string | null;
  /** True while user-initiated fingerprint unlock is running */
  fingerprintBusy: boolean;
  retry: () => void;
  confirmSwitchAccount: () => void;
  /** User accepted "create new Trust ID" after NOT_FOUND lookup */
  confirmCreateAccount: () => void;
  /** User declined create prompt */
  declineCreateAccount: () => void;
  /** Existing account: unlock with fingerprint / device PIN */
  useFingerprintLogin: () => void;
  /** User acknowledged Trust ID is saved on this Master Device */
  continueAfterDeviceSaved: () => void;
  /** User accepted fingerprint backup prompt */
  confirmFingerprintBackup: () => void;
  /** User skipped fingerprint backup */
  skipFingerprintBackup: () => void;
  continueAfterApproval: () => void;
};

/**
 * Identity-first ambient auth — lookup on boot, enroll only after explicit consent.
 * Create → confirm on-device Master save → fingerprint backup → authenticated.
 * Login: face miss → cloud fingerprint → local device unlock → create offer.
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
    hasBoundInstall,
    storeSessionToken,
    getPushToken,
    persistMasterDeviceState,
    unlockWithDeviceCredential,
  } = options;

  const { loading, identity, setIdentity, refresh } = useTrustIdSession();
  const [phase, setPhase] = useState<AmbientAuthPhase>("CHECKING");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AmbientSignInResult | null>(null);
  const [previousTrustId, setPreviousTrustId] = useState<string | null>(null);
  const [approvalPollToken, setApprovalPollToken] = useState<string | null>(null);
  const [fingerprintBusy, setFingerprintBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);
  const pollAbortRef = useRef(false);
  /** Invalidate in-flight ambient runs (Strict Mode / overlapping captures). */
  const runIdRef = useRef(0);
  const pendingResultRef = useRef<AmbientSignInResult | null>(null);
  const pendingPayloadRef = useRef<MultiModalBiometricPayload | null>(null);
  const pendingInstallRef = useRef<string | undefined>(undefined);
  const pendingEnrollRef = useRef<AmbientSignInResult | null>(null);
  /** User-choice screens must not be overwritten by stale async work. */
  const phaseRef = useRef<AmbientAuthPhase>("CHECKING");

  const setPhaseSafe = useCallback((next: AmbientAuthPhase, runId?: number) => {
    if (runId != null && runId !== runIdRef.current) {
      // Stale run was aborted (Strict Mode remount) — still allow it to stop
      // the spinner if we are mid-search and lookup already returned no match.
      const searching =
        phaseRef.current === "PROMPTING" || phaseRef.current === "CHECKING";
      const stopSearch = next === "OFFER_CREATE" || next === "ERROR";
      if (!(searching && stopSearch)) return;
    }
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const isUserChoicePhase = useCallback((p: AmbientAuthPhase) => {
    return (
      p === "OFFER_CREATE" ||
      p === "DEVICE_SAVED" ||
      p === "OFFER_FINGERPRINT" ||
      p === "SWITCH_ACCOUNT" ||
      p === "NEEDS_APPROVAL" ||
      p === "ERROR" ||
      p === "AUTHENTICATED"
    );
  }, []);

  const finishAuthenticated = useCallback(
    async (id?: TrustIdIdentity | null, sessionToken?: string | null) => {
      if (sessionToken && storeSessionToken) {
        try {
          await storeSessionToken(sessionToken);
        } catch {
          /* optional secure store */
        }
      }
      if (id) {
        setIdentity(id);
        onAuthenticated?.(id);
      }
      await refresh();
      setPhaseSafe("AUTHENTICATED");
    },
    [onAuthenticated, refresh, setIdentity, setPhaseSafe, storeSessionToken],
  );

  const completePendingEnroll = useCallback(async () => {
    const pending = pendingEnrollRef.current;
    pendingEnrollRef.current = null;
    if (!pending) {
      await finishAuthenticated();
      return;
    }
    if (pending.identity) {
      await finishAuthenticated(
        pending.identity as TrustIdIdentity,
        pending.sessionToken ?? pending.token,
      );
      return;
    }
    await finishAuthenticated(undefined, pending.sessionToken ?? pending.token);
  }, [finishAuthenticated]);

  const tryBoundInstallUnlock = useCallback(async (): Promise<boolean> => {
    const installId = pendingInstallRef.current;
    if (!installId || !hasBoundInstall?.() || !unlockWithDeviceCredential) {
      return false;
    }
    const ok = await unlockWithDeviceCredential(
      "Face match failed. Verify with Fingerprint or Device PIN",
    );
    if (!ok) return false;
    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const unlocked = await sdk.installUnlock({ installId, localAuthOk: true });
    if (!unlocked.matched) return false;
    setLastResult(unlocked);
    await finishAuthenticated(
      unlocked.identity as TrustIdIdentity | undefined,
      unlocked.sessionToken ?? unlocked.token,
    );
    return true;
  }, [
    apiBaseUrl,
    finishAuthenticated,
    hasBoundInstall,
    unlockWithDeviceCredential,
  ]);

  /**
   * User tapped Fingerprint — cloud FP then local OS unlock.
   * Stays on OFFER_CREATE if unlock fails (never re-enters spinner).
   */
  const useFingerprintLogin = useCallback(() => {
    void (async () => {
      setFingerprintBusy(true);
      setError(null);
      try {
        if (captureFingerprint) {
          try {
            const fingerprint = await captureFingerprint();
            if (fingerprint?.vector || fingerprint?.embedding) {
              const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
              const result = await sdk.ambientSignIn({
                face: pendingPayloadRef.current?.face,
                fingerprint,
                deviceFingerprint:
                  pendingPayloadRef.current?.deviceFingerprint ||
                  (await getDeviceFingerprint?.()) ||
                  undefined,
                installId: pendingInstallRef.current,
                allowAutoEnroll: false,
              });
              if (result.matched) {
                setLastResult(result);
                if (
                  result.needsMasterApproval &&
                  result.approvalPollToken &&
                  result.trustId
                ) {
                  setApprovalPollToken(result.approvalPollToken);
                  setPhaseSafe("NEEDS_APPROVAL");
                  onNeedsApproval?.({
                    trustId: result.trustId,
                    pollToken: result.approvalPollToken,
                    requestId: result.approvalRequestId,
                  });
                  return;
                }
                if (result.identity || result.sessionToken) {
                  await finishAuthenticated(
                    result.identity as TrustIdIdentity | undefined,
                    result.sessionToken ?? result.token,
                  );
                  return;
                }
              }
            }
          } catch {
            /* fall through */
          }
        }

        const unlocked = await tryBoundInstallUnlock();
        if (unlocked) return;

        setError(
          "Fingerprint did not unlock this account. Retry face, or create a new Trust ID.",
        );
        setPhaseSafe("OFFER_CREATE");
      } finally {
        setFingerprintBusy(false);
      }
    })();
  }, [
    apiBaseUrl,
    captureFingerprint,
    finishAuthenticated,
    getDeviceFingerprint,
    onNeedsApproval,
    setPhaseSafe,
    tryBoundInstallUnlock,
  ]);

  const applyMatchedResult = useCallback(
    async (result: AmbientSignInResult, runId?: number) => {
      if (runId != null && runId !== runIdRef.current) return;

      if (result.needsMasterApproval && result.approvalPollToken && result.trustId) {
        setApprovalPollToken(result.approvalPollToken);
        setPhaseSafe("NEEDS_APPROVAL", runId);
        onNeedsApproval?.({
          trustId: result.trustId,
          pollToken: result.approvalPollToken,
          requestId: result.approvalRequestId,
        });
        return;
      }

      // Fresh create: confirm on-device Master save, then fingerprint backup.
      if (result.enrolled && result.matched) {
        pendingEnrollRef.current = result;
        setPhaseSafe("DEVICE_SAVED", runId);
        return;
      }

      if (result.matched && (result.identity || result.sessionToken)) {
        if (result.identity) {
          await finishAuthenticated(
            result.identity as TrustIdIdentity,
            result.sessionToken,
          );
          return;
        }
        await finishAuthenticated(undefined, result.sessionToken);
        return;
      }

      setError(result.error ?? "Biometric recognition failed");
      setPhaseSafe("ERROR", runId);
    },
    [finishAuthenticated, onNeedsApproval, setPhaseSafe],
  );

  const runAmbient = useCallback(async () => {
    const runId = runIdRef.current;
    setPhaseSafe("PROMPTING", runId);
    setError(null);
    setApprovalPollToken(null);
    setPreviousTrustId(null);
    pendingResultRef.current = null;
    pendingPayloadRef.current = null;
    pendingEnrollRef.current = null;

    const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
    const installId = getInstallId ? await getInstallId() : undefined;
    if (runId !== runIdRef.current) return;
    pendingInstallRef.current = installId;

    let payload: MultiModalBiometricPayload | undefined;
    try {
      payload = capturePayload ? await capturePayload() : undefined;
    } catch {
      payload = undefined;
    }
    if (runId !== runIdRef.current) return;

    if (!payload?.face) {
      setError(
        "No face detected. Retry the camera, use fingerprint if you already have a Trust ID, or create one.",
      );
      setPhaseSafe("OFFER_CREATE", runId);
      return;
    }

    pendingPayloadRef.current = payload;

    let lookup;
    try {
      lookup = await sdk.faceLookup({
        face: payload.face,
        installId,
        deviceFingerprint: payload.deviceFingerprint,
        cachedTrustId: getLastTrustId?.() ?? undefined,
      });
    } catch (e) {
      if (runId !== runIdRef.current) return;
      setError(e instanceof Error ? e.message : "Face lookup failed");
      setPhaseSafe("OFFER_CREATE", runId);
      return;
    }
    if (runId !== runIdRef.current) return;

    if (lookup.status === "NOT_FOUND") {
      // Hard stop — no more capture / lookup until the user picks an action.
      if (allowAutoEnroll) {
        const result = await sdk.ambientAuthenticate({
          captureFace,
          captureFingerprint,
          getDeviceFingerprint,
          payload,
          allowAutoEnroll: true,
          installId,
        });
        if (runId !== runIdRef.current) return;
        setLastResult(result);
        await applyMatchedResult(result, runId);
        return;
      }
      setError(null);
      setPhaseSafe("OFFER_CREATE", runId);
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
      await applyMatchedResult(result, runId);
      return;
    }

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
      setPhaseSafe("SWITCH_ACCOUNT", runId);
      return;
    }

    await applyMatchedResult(result, runId);
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
    setPhaseSafe,
  ]);

  const confirmCreateAccount = useCallback(() => {
    const payload = pendingPayloadRef.current;
    if (!payload?.face) {
      startedRef.current = false;
      setNonce((n) => n + 1);
      return;
    }
    setPhaseSafe("ENROLLING");
    setError(null);
    void (async () => {
      const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
      const pushToken = getPushToken ? await getPushToken() : null;
      const installId = pendingInstallRef.current;
      const result = await sdk.registerTrustId({
        ...payload,
        installId,
        deviceName: "Master Phone",
        deviceFingerprint:
          payload.deviceFingerprint ||
          (await getDeviceFingerprint?.()) ||
          installId,
        pushToken: pushToken ?? undefined,
        pushPlatform: pushToken ? "android" : undefined,
      });

      if (result.trustId && persistMasterDeviceState) {
        await persistMasterDeviceState({
          trustId: result.trustId,
          isMasterDevice: true,
          deviceId: result.device?.id ?? null,
        });
      }

      if (result.trustId) {
        try {
          const fp =
            payload.deviceFingerprint ||
            (await getDeviceFingerprint?.()) ||
            installId;
          if (fp) {
            await sdk.bindMasterDevice({
              deviceFingerprint: fp,
              deviceId: result.device?.id,
              deviceName: "Master Phone",
              pushToken: pushToken ?? undefined,
              pushPlatform: pushToken ? "android" : undefined,
            });
          }
        } catch {
          /* optional second bind */
        }
      }

      setLastResult(result);
      await applyMatchedResult(result);
    })().catch((e) => {
      setError(e instanceof Error ? e.message : "Could not create Trust ID");
      setPhaseSafe("ERROR");
    });
  }, [
    apiBaseUrl,
    applyMatchedResult,
    getDeviceFingerprint,
    getPushToken,
    persistMasterDeviceState,
    setPhaseSafe,
  ]);

  const declineCreateAccount = useCallback(() => {
    pendingPayloadRef.current = null;
    setError("No Trust ID was created. Scan again when you are ready.");
    setPhaseSafe("ERROR");
  }, [setPhaseSafe]);

  const continueAfterDeviceSaved = useCallback(() => {
    setPhaseSafe("OFFER_FINGERPRINT");
  }, [setPhaseSafe]);

  const confirmFingerprintBackup = useCallback(() => {
    if (!registerFingerprintBackup) {
      void completePendingEnroll();
      return;
    }
    setPhaseSafe("SAVING_FINGERPRINT");
    setError(null);
    void (async () => {
      const ok = await registerFingerprintBackup();
      if (ok === false) {
        setError(
          "Fingerprint was not saved. You can add it later in Account settings.",
        );
      }
      await completePendingEnroll();
    })().catch((e) => {
      setError(
        e instanceof Error
          ? e.message
          : "Fingerprint backup failed. You can add it later.",
      );
      void completePendingEnroll();
    });
  }, [completePendingEnroll, registerFingerprintBackup, setPhaseSafe]);

  const skipFingerprintBackup = useCallback(() => {
    void completePendingEnroll();
  }, [completePendingEnroll]);

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
        setPhaseSafe("ERROR");
        return;
      }
      if (poll.status !== "approved" && poll.status !== "temporary") {
        setError("Still waiting for your Master Device to approve this terminal.");
        setPhaseSafe("NEEDS_APPROVAL");
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
      setPhaseSafe("ERROR");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not claim approval");
      setPhaseSafe("NEEDS_APPROVAL");
    }
  }, [apiBaseUrl, approvalPollToken, finishAuthenticated, setPhaseSafe]);

  useEffect(() => {
    if (!enabled) return;
    if (identity) {
      setPhaseSafe("AUTHENTICATED");
      return;
    }

    // Session probe in flight — keep current UI; never restart search from loading flips.
    if (loading) return;

    // Already waiting on the user — never auto re-search.
    if (isUserChoicePhase(phaseRef.current) && phaseRef.current !== "AUTHENTICATED") {
      return;
    }

    const scheduledRunId = ++runIdRef.current;
    startedRef.current = true;

    const t = window.setTimeout(() => {
      void runAmbient().catch((e) => {
        if (scheduledRunId !== runIdRef.current) return;
        setError(e instanceof Error ? e.message : "Ambient auth failed");
        setPhaseSafe("OFFER_CREATE", scheduledRunId);
      });
    }, 400);

    return () => {
      window.clearTimeout(t);
      // Abort this scheduled/in-flight search only; a remount will schedule a new one.
      if (runIdRef.current === scheduledRunId) {
        runIdRef.current += 1;
      }
    };
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
          setPhaseSafe("ERROR");
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
                setPhaseSafe("ERROR");
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
  }, [phase, approvalPollToken, apiBaseUrl, finishAuthenticated, setPhaseSafe]);

  const retry = useCallback(() => {
    // Cancel any in-flight run, then allow a fresh search.
    runIdRef.current += 1;
    startedRef.current = false;
    pendingResultRef.current = null;
    // Keep last face payload until a new capture replaces it so Create still works.
    pendingEnrollRef.current = null;
    phaseRef.current = "PROMPTING";
    setPhaseSafe("PROMPTING");
    setError(null);
    setNonce((n) => n + 1);
  }, [setPhaseSafe]);

  return {
    phase: identity ? "AUTHENTICATED" : phase,
    identity,
    error,
    lastResult,
    previousTrustId,
    approvalPollToken,
    fingerprintBusy,
    retry,
    confirmSwitchAccount,
    confirmCreateAccount,
    declineCreateAccount,
    useFingerprintLogin,
    continueAfterDeviceSaved,
    confirmFingerprintBackup,
    skipFingerprintBackup,
    continueAfterApproval: () => {
      void continueAfterApproval();
    },
  };
}
