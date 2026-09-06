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

/**
 * Ambient authentication phases (single state machine).
 * NO_MATCH is terminal for the current scan attempt — camera must stop.
 */
export type AmbientAuthPhase =
  | "CHECKING"
  | "PROMPTING"
  /** Definitive 1:N no identity — scan stopped; user must choose */
  | "NO_MATCH"
  /** @deprecated alias kept for older call sites — use NO_MATCH */
  | "OFFER_CREATE"
  | "ENROLLING"
  | "FACE_SAVED"
  /** @deprecated alias — use FACE_SAVED */
  | "DEVICE_SAVED"
  | "OFFER_FINGERPRINT"
  | "SAVING_FINGERPRINT"
  /** Face persisted but fingerprint backup failed — no auto-login */
  | "FINGERPRINT_FAILED"
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
  capturePayload?: (opts?: {
    signal?: AbortSignal;
  }) => Promise<MultiModalBiometricPayload>;
  /** Multi-frame enrollment capture for Register Trust ID */
  captureEnrollmentPayload?: (opts?: {
    signal?: AbortSignal;
  }) => Promise<MultiModalBiometricPayload>;
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
   * Cryptographic unlock for a bound install (WebAuthn / hardware passkey).
   * REQUIRED for face-fail fallback — local boolean auth is never trusted.
   */
  cryptographicInstallUnlock?: (installId: string) => Promise<{
    ok: boolean;
    identity?: TrustIdIdentity;
    sessionToken?: string | null;
    error?: string;
  }>;
  /**
   * @deprecated Prefer cryptographicInstallUnlock. Local OS prompts alone
   * are not accepted by the API.
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
  /** User skipped fingerprint backup (Finish Later) */
  skipFingerprintBackup: () => void;
  continueAfterApproval: () => void;
};

function normalizePhase(p: AmbientAuthPhase): AmbientAuthPhase {
  if (p === "OFFER_CREATE") return "NO_MATCH";
  if (p === "DEVICE_SAVED") return "FACE_SAVED";
  return p;
}

function isSearchingPhase(p: AmbientAuthPhase): boolean {
  const n = normalizePhase(p);
  return n === "PROMPTING" || n === "CHECKING";
}

function isUserChoicePhase(p: AmbientAuthPhase): boolean {
  const n = normalizePhase(p);
  return (
    n === "NO_MATCH" ||
    n === "FACE_SAVED" ||
    n === "OFFER_FINGERPRINT" ||
    n === "FINGERPRINT_FAILED" ||
    n === "SWITCH_ACCOUNT" ||
    n === "NEEDS_APPROVAL" ||
    n === "ERROR" ||
    n === "AUTHENTICATED"
  );
}

function isServiceFailureMessage(msg: string): boolean {
  return /BIOMETRIC_SERVICE_UNAVAILABLE|SERVICE_UNAVAILABLE|BIOMETRIC_MODEL_UNAVAILABLE|unavailable|503|502|network|failed to fetch/i.test(
    msg,
  );
}

/**
 * Identity-first ambient auth — lookup on boot, enroll only after explicit consent.
 * Create → confirm on-device Master save → fingerprint backup → authenticated.
 * NO_MATCH terminates the current scan; user must Retry / Fingerprint / Register.
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
    captureEnrollmentPayload,
    registerFingerprintBackup,
    hasBoundInstall,
    storeSessionToken,
    getPushToken,
    persistMasterDeviceState,
    cryptographicInstallUnlock,
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
  const captureAbortRef = useRef<AbortController | null>(null);
  const pendingResultRef = useRef<AmbientSignInResult | null>(null);
  const pendingPayloadRef = useRef<MultiModalBiometricPayload | null>(null);
  const pendingInstallRef = useRef<string | undefined>(undefined);
  const pendingEnrollRef = useRef<AmbientSignInResult | null>(null);
  /** User-choice screens must not be overwritten by stale async work. */
  const phaseRef = useRef<AmbientAuthPhase>("CHECKING");

  const abortCapture = useCallback(() => {
    try {
      captureAbortRef.current?.abort();
    } catch {
      /* ignore */
    }
    captureAbortRef.current = null;
  }, []);

  const setPhaseSafe = useCallback((next: AmbientAuthPhase, runId?: number) => {
    const normalized = normalizePhase(next);
    if (runId != null && runId !== runIdRef.current) {
      // Stale run — only allow terminal stop of an active search UI.
      const searching = isSearchingPhase(phaseRef.current);
      const stopSearch =
        normalized === "NO_MATCH" ||
        normalized === "ERROR" ||
        normalized === "AUTHENTICATED" ||
        normalized === "NEEDS_APPROVAL" ||
        normalized === "SWITCH_ACCOUNT";
      if (!(searching && stopSearch)) return;
    }
    // Never overwrite an active user-choice screen with a searching phase.
    if (
      isUserChoicePhase(phaseRef.current) &&
      isSearchingPhase(normalized) &&
      phaseRef.current !== "AUTHENTICATED"
    ) {
      return;
    }
    phaseRef.current = normalized;
    setPhase(normalized);
    if (
      normalized === "NO_MATCH" ||
      normalized === "ERROR" ||
      normalized === "AUTHENTICATED" ||
      normalized === "FACE_SAVED" ||
      normalized === "NEEDS_APPROVAL" ||
      normalized === "SWITCH_ACCOUNT"
    ) {
      abortCapture();
    }
  }, [abortCapture]);

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
    if (!installId || !hasBoundInstall?.()) {
      return false;
    }

    if (cryptographicInstallUnlock) {
      const result = await cryptographicInstallUnlock(installId);
      if (!result.ok) return false;
      await finishAuthenticated(
        result.identity,
        result.sessionToken ?? undefined,
      );
      return true;
    }

    void unlockWithDeviceCredential;
    return false;
  }, [
    cryptographicInstallUnlock,
    finishAuthenticated,
    hasBoundInstall,
    unlockWithDeviceCredential,
  ]);

  /**
   * User tapped Fingerprint / Passkey — cryptographic unlock first.
   * Stays on NO_MATCH if unlock fails (never re-enters spinner).
   */
  const useFingerprintLogin = useCallback(() => {
    void (async () => {
      setFingerprintBusy(true);
      setError(null);
      try {
        const unlocked = await tryBoundInstallUnlock();
        if (unlocked) return;

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
              setError(
                result.error ??
                  "FINGERPRINT_UNAVAILABLE — fingerprint did not unlock a Trust ID.",
              );
              setPhaseSafe("NO_MATCH");
              return;
            }
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "FINGERPRINT_UNAVAILABLE — fingerprint unlock failed.",
            );
            setPhaseSafe("NO_MATCH");
            return;
          }
        }

        setError(
          "FINGERPRINT_UNAVAILABLE — register a passkey in Account, retry face, or create a new Trust ID.",
        );
        setPhaseSafe("NO_MATCH");
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

      abortCapture();

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
        setPhaseSafe("FACE_SAVED", runId);
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
    [abortCapture, finishAuthenticated, onNeedsApproval, setPhaseSafe],
  );

  const enterNoMatch = useCallback(
    (runId: number) => {
      // Invalidate any concurrent/stale work; this scan attempt is done.
      if (runId === runIdRef.current) {
        runIdRef.current += 1;
      }
      abortCapture();
      setError(null);
      setPhaseSafe("NO_MATCH", runId);
    },
    [abortCapture, setPhaseSafe],
  );

  const enterServiceError = useCallback(
    (runId: number, message: string) => {
      if (runId === runIdRef.current) {
        runIdRef.current += 1;
      }
      abortCapture();
      setError(message);
      setPhaseSafe("ERROR", runId);
    },
    [abortCapture, setPhaseSafe],
  );

  const runAmbient = useCallback(async () => {
    const runId = runIdRef.current;
    // Never start a new scan while the user is on a choice screen.
    if (isUserChoicePhase(phaseRef.current) && phaseRef.current !== "AUTHENTICATED") {
      return;
    }

    abortCapture();
    const ac = new AbortController();
    captureAbortRef.current = ac;

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
      payload = capturePayload
        ? await capturePayload({ signal: ac.signal })
        : undefined;
    } catch {
      payload = undefined;
    }
    if (ac.signal.aborted || runId !== runIdRef.current) return;

    if (!payload?.face) {
      enterServiceError(
        runId,
        "CAMERA_ERROR — No face detected. Retry the camera, use fingerprint if you already have a Trust ID, or register.",
      );
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
      const msg = e instanceof Error ? e.message : "Face lookup failed";
      enterServiceError(
        runId,
        isServiceFailureMessage(msg)
          ? `BIOMETRIC_SERVICE_UNAVAILABLE — ${msg}`
          : msg,
      );
      return;
    }

    // Definitive outcomes must stop the scan even across Strict Mode races
    // when we are still showing a searching UI.
    if (lookup.status === "SERVICE_UNAVAILABLE") {
      enterServiceError(
        runId,
        lookup.message ??
          "BIOMETRIC_SERVICE_UNAVAILABLE — identification service is temporarily down.",
      );
      return;
    }

    if (lookup.status === "NOT_FOUND") {
      if (allowAutoEnroll) {
        if (runId !== runIdRef.current) return;
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
      // Terminal for this scan attempt — stop camera; wait for user.
      enterNoMatch(runId);
      return;
    }

    if (runId !== runIdRef.current) return;

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
    abortCapture,
    captureFace,
    captureFingerprint,
    capturePayload,
    enterNoMatch,
    enterServiceError,
    getDeviceFingerprint,
    getInstallId,
    getLastTrustId,
    setPhaseSafe,
  ]);

  const confirmCreateAccount = useCallback(() => {
    // Explicit registration only — never from a silent path.
    setPhaseSafe("ENROLLING");
    setError(null);
    abortCapture();
    const ac = new AbortController();
    captureAbortRef.current = ac;

    void (async () => {
      const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
      let payload = pendingPayloadRef.current;

      // Prefer dedicated multi-frame enrollment capture when available.
      if (captureEnrollmentPayload) {
        try {
          const enrolled = await captureEnrollmentPayload({
            signal: ac.signal,
          });
          if (enrolled?.face?.vector?.length === 512) {
            payload = {
              ...payload,
              ...enrolled,
              face: enrolled.face,
            };
            pendingPayloadRef.current = payload;
          }
        } catch {
          /* fall back to pending identification face */
        }
      }

      if (!payload?.face?.vector && !payload?.face?.embedding) {
        setError(
          "REGISTRATION_FAILED — No face template available. Retry face scan, then Register.",
        );
        setPhaseSafe("ERROR");
        return;
      }

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

      if (!result.matched && !result.enrolled && !result.trustId) {
        setError(
          result.error ??
            "REGISTRATION_FAILED — Face could not be saved. Try again.",
        );
        setPhaseSafe("ERROR");
        return;
      }

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

      // Only confirm FACE_SAVED when persistence succeeded.
      if (!result.trustId) {
        setError("REGISTRATION_FAILED — Face was not persisted.");
        setPhaseSafe("ERROR");
        return;
      }

      setLastResult({ ...result, enrolled: true, matched: true });
      pendingEnrollRef.current = { ...result, enrolled: true, matched: true };
      abortCapture();
      setPhaseSafe("FACE_SAVED");
    })().catch((e) => {
      setError(e instanceof Error ? e.message : "Could not create Trust ID");
      setPhaseSafe("ERROR");
    });
  }, [
    abortCapture,
    apiBaseUrl,
    captureEnrollmentPayload,
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
      setError(
        "FINGERPRINT_UNAVAILABLE — fingerprint backup is not available on this device.",
      );
      setPhaseSafe("FINGERPRINT_FAILED");
      return;
    }
    setPhaseSafe("SAVING_FINGERPRINT");
    setError(null);
    void (async () => {
      const ok = await registerFingerprintBackup();
      if (ok === false) {
        setError(
          "Your face was saved, but fingerprint backup wasn't completed.",
        );
        setPhaseSafe("FINGERPRINT_FAILED");
        return;
      }
      await completePendingEnroll();
    })().catch((e) => {
      setError(
        e instanceof Error
          ? e.message
          : "Your face was saved, but fingerprint backup wasn't completed.",
      );
      setPhaseSafe("FINGERPRINT_FAILED");
    });
  }, [completePendingEnroll, registerFingerprintBackup, setPhaseSafe]);

  const skipFingerprintBackup = useCallback(() => {
    // Finish Later — allowed by existing policy after face is saved.
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
        const msg = e instanceof Error ? e.message : "Ambient auth failed";
        enterServiceError(
          scheduledRunId,
          isServiceFailureMessage(msg)
            ? `BIOMETRIC_SERVICE_UNAVAILABLE — ${msg}`
            : msg,
        );
      });
    }, 400);

    return () => {
      window.clearTimeout(t);
      abortCapture();
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
    // Fresh authentication attempt — abort prior camera + invalidate runs.
    abortCapture();
    runIdRef.current += 1;
    startedRef.current = false;
    pendingResultRef.current = null;
    pendingEnrollRef.current = null;
    pendingPayloadRef.current = null;
    phaseRef.current = "PROMPTING";
    setPhase("PROMPTING");
    setError(null);
    setNonce((n) => n + 1);
  }, [abortCapture]);

  return {
    phase: identity ? "AUTHENTICATED" : normalizePhase(phase),
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
