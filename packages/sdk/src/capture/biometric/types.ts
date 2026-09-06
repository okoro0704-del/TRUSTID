/**
 * TrustID production face biometric types.
 * FACE_DETECTION | FACE_QUALITY | LIVENESS/PAD | FACE_RECOGNITION are separate stages.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  BIOMETRIC_PREPROCESSING_VERSION,
  type BiometricErrorCode,
} from "@trustid/shared";

export type Point2D = { x: number; y: number };

export type FaceBoundingBox = {
  xMin: number;
  yMin: number;
  width: number;
  height: number;
};

/** Five ArcFace reference landmarks in image pixel space */
export type FaceLandmarks5 = {
  leftEye: Point2D;
  rightEye: Point2D;
  nose: Point2D;
  leftMouth: Point2D;
  rightMouth: Point2D;
};

export type DetectedFace = {
  box: FaceBoundingBox;
  confidence: number;
  landmarks: FaceLandmarks5;
};

export type FaceQualityResult = {
  ok: boolean;
  score: number;
  reasons: string[];
};

export type PadDecision = "accept" | "reject" | "unavailable";

export type FacePadResult = {
  score: number;
  decision: PadDecision;
  modelVersion: string;
  reason: string;
};

export type FacePresentationAttackDetector = {
  readonly modelVersion: string;
  evaluate(input: {
    imageData: ImageData;
    face: DetectedFace;
    alignedRgb112?: Float32Array;
  }): Promise<FacePadResult>;
};

export type BiometricPipelineMeta = {
  modelName: typeof BIOMETRIC_AI_MODEL_NAME | string;
  modelVersion: number;
  embeddingDimensions: number;
  detectorVersion: string;
  alignmentVersion: string;
  preprocessingVersion: string;
};

export type AIVectorPayload = {
  modality: typeof BIOMETRIC_MODALITIES.FACE | typeof BIOMETRIC_MODALITIES.FINGERPRINT;
  vector: number[];
  modelName: string;
  modelVersion: number;
  confidence: number;
  detectorVersion?: string;
  alignmentVersion?: string;
  preprocessingVersion?: string;
  padScore?: number;
  padModelVersion?: string;
  errorCode?: BiometricErrorCode;
  errorMessage?: string;
};

export type BiometricExtractError = {
  ok: false;
  code: BiometricErrorCode;
  message: string;
};

export type BiometricExtractSuccess = {
  ok: true;
  payload: AIVectorPayload;
  face: DetectedFace;
  quality: FaceQualityResult;
  pad: FacePadResult;
};

export type BiometricExtractResult = BiometricExtractSuccess | BiometricExtractError;

export const PRODUCTION_PIPELINE_META: BiometricPipelineMeta = {
  modelName: BIOMETRIC_AI_MODEL_NAME,
  modelVersion: BIOMETRIC_AI_MODEL_VERSION,
  embeddingDimensions: BIOMETRIC_AI_EMBEDDING_DIMS,
  detectorVersion: BIOMETRIC_DETECTOR_VERSION,
  alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
  preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
};

export function isBiometricErrorCode(v: string): v is BiometricErrorCode {
  return Object.values(BIOMETRIC_ERROR_CODES).includes(v as BiometricErrorCode);
}
