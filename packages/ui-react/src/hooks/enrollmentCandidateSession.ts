/**
 * Ephemeral in-memory enrollment candidate for the current JS session.
 * Survives React remounts / Strict Mode (unlike useRef).
 * NOT durable storage — production templates live in BiometricEmbedding (API/DB).
 * Never write vectors to localStorage / sessionStorage.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  isProductionArcFaceModelName,
  type FaceLifecycleDiagnostics,
} from "@trustid/shared";
import type { MultiModalBiometricPayload } from "@trustid/sdk";

export type EnrollmentCandidateFace = NonNullable<
  MultiModalBiometricPayload["face"]
>;

type SessionCandidate = {
  face: EnrollmentCandidateFace;
  capturedAt: number;
  source: "identification" | "enrollment" | "fresh";
};

let sessionCandidate: SessionCandidate | null = null;
let lastDiagnostics: FaceLifecycleDiagnostics = {};

export function isArcFaceEnrollmentFace(
  face: EnrollmentCandidateFace | undefined | null,
): face is EnrollmentCandidateFace {
  if (!face?.vector || face.vector.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    return false;
  }
  return isProductionArcFaceModelName(face.modelName);
}

export function setEnrollmentCandidate(
  face: EnrollmentCandidateFace,
  source: SessionCandidate["source"],
): boolean {
  if (!isArcFaceEnrollmentFace(face)) return false;
  sessionCandidate = {
    face: {
      modality: "face",
      vector: face.vector,
      modelName: face.modelName,
      modelVersion: face.modelVersion,
      confidence: face.confidence,
      deviceFingerprint: face.deviceFingerprint,
    },
    capturedAt: Date.now(),
    source,
  };
  patchFaceDiagnostics({
    faceDetected: true,
    vectorCreated: true,
    vectorDims: face.vector!.length,
    modelName: face.modelName ?? null,
    stage: "vector_created",
    errorCode: null,
  });
  return true;
}

/** Peek without clearing — Register may retry after a transient API error. */
export function peekEnrollmentCandidate(): SessionCandidate | null {
  return sessionCandidate;
}

export function clearEnrollmentCandidate(): void {
  sessionCandidate = null;
}

export function patchFaceDiagnostics(
  partial: FaceLifecycleDiagnostics,
): FaceLifecycleDiagnostics {
  lastDiagnostics = { ...lastDiagnostics, ...partial };
  return lastDiagnostics;
}

export function getFaceDiagnostics(): FaceLifecycleDiagnostics {
  return { ...lastDiagnostics };
}

/** Development-only: wipe ephemeral candidate so the next scan re-enrolls. */
export function resetEnrollmentCandidateForDev(): void {
  sessionCandidate = null;
  lastDiagnostics = {
    templateAvailable: false,
    templateId: null,
    stage: "camera_ready",
    errorCode: null,
  };
}
