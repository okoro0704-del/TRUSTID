import { useCallback, useEffect, useRef, useState } from "react";
import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ERROR_CODES,
  type FaceLifecycleDiagnostics,
} from "@trustid/shared";
import {
  createTrustIdSdk,
  enrollmentDiag,
  newBiometricEnrollmentAttemptId,
  summarizeEmbeddingMeta,
  type AmbientSignInResult,
  type CaptureHandlers,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import { resolveGuestRealtimeUrl } from "../api/client.js";
import { useTrustIdAuth as useTrustIdSession } from "../context/TrustIdAuthProvider.js";
import type { TrustIdIdentity } from "../types.js";
import {
  clearEnrollmentCandidate,
  getFaceDiagnostics,
  isArcFaceEnrollmentFace,
  patchFaceDiagnostics,
  peekEnrollmentCandidate,
  resetEnrollmentCandidateForDev,
  setEnrollmentCandidate,
} from "./enrollmentCandidateSession.js";

function isProductionArcFaceFace(
  face: MultiModalBiometricPayload["face"] | undefined | null,
): boolean {
  return isArcFaceEnrollmentFace(face);
}

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
  /** Safe face-lifecycle diagnostics (no vectors/images) */
  faceDiagnostics: FaceLifecycleDiagnostics;
  lastResult: AmbientSignInResult | null;
  previousTrustId: string | null;
  approvalPollToken: string | null;
  /** True while user-initiated fingerprint unlock is running */
  fingerprintBusy: boolean;
  retry: () => void;
  /** Dev-only: clear ephemeral enrollment candidate and rescan */
  resetFaceEnrollmentForDev: () => void;
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
  const [faceDiagnostics, setFaceDiagnostics] = useState<FaceLifecycleDiagnostics>(
    () => getFaceDiagnostics(),
  );
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

  const syncDiagnostics = useCallback((partial: FaceLifecycleDiagnostics) => {
    setFaceDiagnostics(patchFaceDiagnostics(partial));
  }, []);

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
      // Keep ArcFace identification face for Register (module session survives remounts).
      const face = pendingPayloadRef.current?.face;
      if (isProductionArcFaceFace(face)) {
        setEnrollmentCandidate(face!, "identification");
        syncDiagnostics({
          faceDetected: true,
          vectorCreated: true,
          vectorDims: face!.vector!.length,
          modelName: face!.modelName ?? null,
          templateAvailable: false,
          templateId: null,
          stage: "vector_created",
          errorCode: BIOMETRIC_ERROR_CODES.FACE_NOT_ENROLLED,
        });
      } else {
        syncDiagnostics({
          faceDetected: Boolean(face),
          vectorCreated: false,
          modelName: face?.modelName ?? null,
          templateAvailable: false,
          errorCode: BIOMETRIC_ERROR_CODES.FACE_VECTOR_UNAVAILABLE,
        });
      }
      setPhaseSafe("NO_MATCH", runId);
    },
    [abortCapture, setPhaseSafe, syncDiagnostics],
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
      const code =
        payload?.captureErrorCode ?? BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED;
      const detail =
        payload?.captureErrorMessage ??
        "No face detected. Retry the camera, use fingerprint if you already have a Trust ID, or register.";
      enterServiceError(runId, `${code} — ${detail}`);
      syncDiagnostics({
        cameraReady: true,
        faceDetected: code !== BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED &&
          code !== BIOMETRIC_ERROR_CODES.NO_FACE &&
          code !== BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE,
        vectorCreated: false,
        errorCode: code,
        stage:
          code === BIOMETRIC_ERROR_CODES.LIVENESS_FAILED
            ? "liveness_failed"
            : code === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE
              ? "model_unavailable"
              : "face_not_detected",
      });
      return;
    }

    if (!isProductionArcFaceFace(payload.face)) {
      enterServiceError(
        runId,
        `${BIOMETRIC_ERROR_CODES.FACE_VECTOR_UNAVAILABLE} — Production ArcFace face vector unavailable. Check models at /models/trustid.`,
      );
      syncDiagnostics({
        faceDetected: true,
        vectorCreated: false,
        modelName: payload.face.modelName ?? null,
        vectorDims: payload.face.vector?.length,
        errorCode: BIOMETRIC_ERROR_CODES.FACE_VECTOR_UNAVAILABLE,
        onnxActive: false,
        spatialFallbackActive: /spatial_fallback/i.test(
          String(payload.face.modelName ?? ""),
        ),
      });
      return;
    }

    pendingPayloadRef.current = payload;
    setEnrollmentCandidate(payload.face, "identification");
    syncDiagnostics({
      cameraReady: true,
      faceDetected: true,
      vectorCreated: true,
      vectorDims: payload.face.vector!.length,
      modelName: payload.face.modelName ?? null,
      onnxActive: true,
      spatialFallbackActive: false,
      modelReady: true,
      stage: "vector_created",
      errorCode: null,
    });

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
    syncDiagnostics,
  ]);

  const confirmCreateAccount = useCallback(() => {
    // Explicit registration only — never from a silent path.
    setPhaseSafe("ENROLLING");
    setError(null);
    abortCapture();
    const ac = new AbortController();
    captureAbortRef.current = ac;

    void (async () => {
      const attemptId = newBiometricEnrollmentAttemptId();
      const enrollStartedAt = Date.now();
      enrollmentDiag({
        attemptId,
        stage: "ENROLLMENT_STARTED",
        status: "started",
        startedAt: enrollStartedAt,
      });
      const sdk = createTrustIdSdk({ baseUrl: apiBaseUrl });
      syncDiagnostics({
        enrollmentStarted: true,
        stage: "enrollment_started",
        errorCode: null,
      });

      let enrolledFace: MultiModalBiometricPayload["face"] | undefined;
      let enrollSource: "probe" | "enrollment" | "fresh" | "none" = "none";
      let lastCaptureError: {
        code: string;
        message: string;
      } | null = null;

      // 1) Module-session ArcFace candidate (survives remounts) + pending probe.
      const session = peekEnrollmentCandidate();
      if (session && isProductionArcFaceFace(session.face)) {
        enrolledFace = session.face;
        enrollSource = "probe";
      } else if (isProductionArcFaceFace(pendingPayloadRef.current?.face)) {
        enrolledFace = pendingPayloadRef.current!.face;
        enrollSource = "probe";
        setEnrollmentCandidate(enrolledFace!, "identification");
      }

      // 2) Optional multi-frame enrollment (blink + quality aggregate).
      if (!enrolledFace && captureEnrollmentPayload) {
        try {
          const enrolled = await captureEnrollmentPayload({
            signal: ac.signal,
          });
          if (isProductionArcFaceFace(enrolled?.face)) {
            const faceOk = enrolled!.face!;
            enrolledFace = faceOk;
            enrollSource = "enrollment";
            setEnrollmentCandidate(faceOk, "enrollment");
          } else if (enrolled?.captureErrorCode) {
            lastCaptureError = {
              code: enrolled.captureErrorCode,
              message:
                enrolled.captureErrorMessage ?? enrolled.captureErrorCode,
            };
          }
        } catch (e) {
          setError(
            e instanceof Error
              ? e.message
              : `${BIOMETRIC_ERROR_CODES.FACE_VECTOR_UNAVAILABLE} — Enrollment capture failed.`,
          );
          syncDiagnostics({
            errorCode: BIOMETRIC_ERROR_CODES.FACE_VECTOR_UNAVAILABLE,
          });
          setPhaseSafe("ERROR");
          return;
        }
      }

      // 3) Fresh single-frame capture (same path as identity scan).
      if (!enrolledFace && capturePayload) {
        try {
          const fresh = await capturePayload({ signal: ac.signal });
          if (isProductionArcFaceFace(fresh?.face)) {
            const faceOk = fresh!.face!;
            enrolledFace = faceOk;
            enrollSource = "fresh";
            setEnrollmentCandidate(faceOk, "fresh");
          } else if (fresh?.captureErrorCode) {
            lastCaptureError = {
              code: fresh.captureErrorCode,
              message: fresh.captureErrorMessage ?? fresh.captureErrorCode,
            };
          } else if (fresh?.face) {
            enrolledFace = fresh.face;
          }
        } catch (e) {
          setError(
            e instanceof Error
              ? e.message
              : `${BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE} — Face capture failed.`,
          );
          syncDiagnostics({
            errorCode: BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE,
          });
          setPhaseSafe("ERROR");
          return;
        }
      }

      if (!isProductionArcFaceFace(enrolledFace)) {
        const badModel = enrolledFace?.modelName ?? "missing";
        const legacy = /spatial_fallback|mobile_facenet/i.test(String(badModel));
        const code = legacy
          ? BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY
          : enrolledFace
            ? BIOMETRIC_ERROR_CODES.FACE_VECTOR_UNAVAILABLE
            : (lastCaptureError?.code ??
              BIOMETRIC_ERROR_CODES.FACE_NOT_ENROLLED);
        const detail = legacy
          ? "Legacy spatial/non-ArcFace template rejected. Retry face scan, then Register."
          : lastCaptureError?.message && !enrolledFace
            ? lastCaptureError.message
            : enrolledFace
              ? "No production ArcFace face vector ready to enroll. Retry face scan, then Register."
              : "No production ArcFace face vector ready to enroll. Retry face scan, then Register.";
        setError(`${code} — ${detail}`);
        enrollmentDiag({
          attemptId,
          stage: "EMBEDDING_VALIDATION",
          status: "failed",
          errorCode: code,
          errorMessage: detail,
          modelName: badModel === "missing" ? undefined : String(badModel),
          enrollSource,
        });
        syncDiagnostics({
          faceDetected: Boolean(enrolledFace) ||
            lastCaptureError?.code === BIOMETRIC_ERROR_CODES.LIVENESS_FAILED ||
            lastCaptureError?.code === BIOMETRIC_ERROR_CODES.LOW_QUALITY,
          vectorCreated: false,
          modelName: badModel === "missing" ? null : String(badModel),
          templateAvailable: false,
          errorCode: code,
        });
        setPhaseSafe("ERROR");
        return;
      }

      // Build a clean enrollment payload — no legacy embedding field, no stale state.
      const face = {
        modality: "face" as const,
        vector: enrolledFace!.vector!,
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: BIOMETRIC_AI_MODEL_VERSION,
        confidence: enrolledFace!.confidence,
        deviceFingerprint: enrolledFace!.deviceFingerprint,
      };
      const embMeta = summarizeEmbeddingMeta(face.vector);
      enrollmentDiag({
        attemptId,
        stage: "EMBEDDING_VALIDATION",
        status:
          embMeta.embeddingLength === 512 &&
          embMeta.embeddingFinite &&
          embMeta.embeddingNormOk &&
          !embMeta.embeddingAllZero
            ? "ok"
            : "failed",
        ...embMeta,
        modelName: face.modelName,
        enrollSource,
      });
      const payload: MultiModalBiometricPayload = { face };
      pendingPayloadRef.current = payload;

      console.info(
        JSON.stringify({
          scope: "ambient_register",
          event: "arcface_enroll_submit",
          source: enrollSource,
          modelName: face.modelName,
          modelVersion: face.modelVersion,
          embeddingDims: face.vector.length,
          // never log vector / image
        }),
      );

      const pushToken = getPushToken ? await getPushToken() : null;
      const installId = pendingInstallRef.current;
      enrollmentDiag({
        attemptId,
        stage: "ENROLLMENT_REQUEST",
        status: "started",
        endpoint: "/v1/identity/register-trust-id",
        embeddingLength: face.vector.length,
        enrollSource,
      });
      const result = await sdk.registerTrustId({
        face,
        installId,
        deviceName: "Master Phone",
        deviceFingerprint:
          face.deviceFingerprint ||
          (await getDeviceFingerprint?.()) ||
          installId,
        pushToken: pushToken ?? undefined,
        pushPlatform: pushToken ? "android" : undefined,
      });
      enrollmentDiag({
        attemptId,
        stage: "ENROLLMENT_RESPONSE",
        status: result.trustId || result.enrolled ? "ok" : "failed",
        endpoint: "/v1/identity/register-trust-id",
        enrollSource,
        errorCode: result.trustId ? undefined : "FACE_TEMPLATE_UNAVAILABLE",
      });

      if (!result.matched && !result.enrolled && !result.trustId) {
        setError(
          result.error ??
            `${BIOMETRIC_ERROR_CODES.FACE_TEMPLATE_UNAVAILABLE} — Face could not be saved. Try again.`,
        );
        syncDiagnostics({
          errorCode: BIOMETRIC_ERROR_CODES.FACE_TEMPLATE_UNAVAILABLE,
          templateAvailable: false,
        });
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
            face.deviceFingerprint ||
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
        setError(
          `${BIOMETRIC_ERROR_CODES.FACE_TEMPLATE_UNAVAILABLE} — Face was not persisted.`,
        );
        syncDiagnostics({
          errorCode: BIOMETRIC_ERROR_CODES.FACE_TEMPLATE_UNAVAILABLE,
          templateAvailable: false,
        });
        setPhaseSafe("ERROR");
        return;
      }

      clearEnrollmentCandidate();
      syncDiagnostics({
        templateAvailable: true,
        templateId:
          "faceEmbeddingId" in result && result.faceEmbeddingId
            ? String(result.faceEmbeddingId)
            : null,
        trustId: result.trustId,
        enrollmentStarted: true,
        stage: "template_persisted",
        errorCode: null,
      });
      enrollmentDiag({
        attemptId,
        stage: "ENROLLMENT_PERSISTENCE",
        status: "ok",
        enrollSource,
        durationMs: Date.now() - enrollStartedAt,
      });
      enrollmentDiag({
        attemptId,
        stage: "ENROLLMENT_COMPLETE",
        status: "ok",
        enrollSource,
        durationMs: Date.now() - enrollStartedAt,
        embeddingLength: face.vector.length,
        modelName: face.modelName,
      });
      setLastResult({ ...result, enrolled: true, matched: true });
      pendingEnrollRef.current = { ...result, enrolled: true, matched: true };
      abortCapture();
      setPhaseSafe("FACE_SAVED");
    })().catch((e) => {
      setError(e instanceof Error ? e.message : "Could not create Trust ID");
      syncDiagnostics({
        errorCode: BIOMETRIC_ERROR_CODES.FACE_TEMPLATE_UNAVAILABLE,
      });
      setPhaseSafe("ERROR");
    });
  }, [
    abortCapture,
    apiBaseUrl,
    captureEnrollmentPayload,
    capturePayload,
    getDeviceFingerprint,
    getPushToken,
    persistMasterDeviceState,
    setPhaseSafe,
    syncDiagnostics,
  ]);

  const declineCreateAccount = useCallback(() => {
    pendingPayloadRef.current = null;
    clearEnrollmentCandidate();
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
    clearEnrollmentCandidate();
    syncDiagnostics({
      templateAvailable: false,
      templateId: null,
      vectorCreated: false,
      stage: "camera_ready",
      errorCode: null,
    });
    phaseRef.current = "PROMPTING";
    setPhase("PROMPTING");
    setError(null);
    setNonce((n) => n + 1);
  }, [abortCapture, syncDiagnostics]);

  const resetFaceEnrollmentForDev = useCallback(() => {
    resetEnrollmentCandidateForDev();
    syncDiagnostics(getFaceDiagnostics());
    retry();
  }, [retry, syncDiagnostics]);

  return {
    phase: identity ? "AUTHENTICATED" : normalizePhase(phase),
    identity,
    error,
    faceDiagnostics,
    lastResult,
    previousTrustId,
    approvalPollToken,
    fingerprintBusy,
    retry,
    resetFaceEnrollmentForDev,
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
