/**
 * Enrollment attempt diagnostics — metadata only.
 * Enable: localStorage.TRUSTID_ENROLL_DIAG = "1"
 * Never logs frames, crops, embeddings, tokens, or credentials.
 */

export type EnrollmentStage =
  | "ENROLLMENT_STARTED"
  | "CAMERA_PERMISSION"
  | "CAMERA_STREAM"
  | "FRAME_CAPTURE"
  | "FACE_DETECTION"
  | "FACE_QUALITY"
  | "FACE_ALIGNMENT"
  | "ARCFACE_PREPROCESS"
  | "ARCFACE_INFERENCE"
  | "EMBEDDING_VALIDATION"
  | "LIVENESS_PAD"
  | "ENROLLMENT_REQUEST"
  | "ENROLLMENT_RESPONSE"
  | "ENROLLMENT_PERSISTENCE"
  | "ENROLLMENT_COMPLETE";

export type EnrollmentStageEvent = {
  scope: "biometric_enrollment_diag";
  attemptId: string;
  stage: EnrollmentStage | string;
  status: "started" | "ok" | "failed" | "skipped";
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  faceCount?: number;
  frameWidth?: number;
  frameHeight?: number;
  videoReadyState?: number;
  embeddingLength?: number;
  embeddingFinite?: boolean;
  embeddingNormOk?: boolean;
  embeddingAllZero?: boolean;
  modelName?: string;
  httpStatus?: number;
  endpoint?: string;
  enrollSource?: string;
};

function diagEnabled(): boolean {
  if (typeof window === "undefined") {
    return process.env.TRUSTID_ENROLL_DIAG === "1";
  }
  try {
    const w = window as Window & { __TRUSTID_ENROLL_DIAG__?: boolean };
    if (w.__TRUSTID_ENROLL_DIAG__ === true) return true;
    return window.localStorage?.getItem("TRUSTID_ENROLL_DIAG") === "1";
  } catch {
    return false;
  }
}

export function newBiometricEnrollmentAttemptId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `BIO-${rand}`;
}

export function sanitizeEnrollmentDiagMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[0-9a-f]{64}/gi, (h) => `${h.slice(0, 12)}…`)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 240);
}

export function enrollmentDiag(
  event: Omit<EnrollmentStageEvent, "scope">,
): void {
  if (!diagEnabled()) return;
  const safe: EnrollmentStageEvent = {
    scope: "biometric_enrollment_diag",
    attemptId: event.attemptId,
    stage: event.stage,
    status: event.status,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    durationMs: event.durationMs,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage
      ? sanitizeEnrollmentDiagMessage(event.errorMessage)
      : undefined,
    faceCount: event.faceCount,
    frameWidth: event.frameWidth,
    frameHeight: event.frameHeight,
    videoReadyState: event.videoReadyState,
    embeddingLength: event.embeddingLength,
    embeddingFinite: event.embeddingFinite,
    embeddingNormOk: event.embeddingNormOk,
    embeddingAllZero: event.embeddingAllZero,
    modelName: event.modelName,
    httpStatus: event.httpStatus,
    endpoint: event.endpoint,
    enrollSource: event.enrollSource,
  };
  console.info("[TrustID]", JSON.stringify(safe));
}

/** Safe embedding metadata — never returns values. */
export function summarizeEmbeddingMeta(vector: unknown): {
  embeddingLength: number;
  embeddingFinite: boolean;
  embeddingNormOk: boolean;
  embeddingAllZero: boolean;
} {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    return {
      embeddingLength: 0,
      embeddingFinite: false,
      embeddingNormOk: false,
      embeddingAllZero: true,
    };
  }
  const arr = Array.isArray(vector) ? vector : Array.from(vector);
  let sumSq = 0;
  let finite = true;
  let allZero = true;
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isFinite(n)) finite = false;
    if (n !== 0) allZero = false;
    sumSq += n * n;
  }
  return {
    embeddingLength: arr.length,
    embeddingFinite: finite,
    embeddingNormOk: finite && sumSq > 0,
    embeddingAllZero: allZero,
  };
}
