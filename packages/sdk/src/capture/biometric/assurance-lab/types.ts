/**
 * TrustID Assurance Lab - evaluation-only types.
 *
 * A lab result is an EVALUATION_RESULT. It is never an authenticated human,
 * never a TrustID, never a session, and never authority.
 */

export const LAB_EVIDENCE_PROVENANCE = {
  REAL_HUMAN_CONSENTED: "REAL_HUMAN_CONSENTED",
  SYNTHETIC: "SYNTHETIC",
} as const;

export type LabEvidenceProvenance =
  (typeof LAB_EVIDENCE_PROVENANCE)[keyof typeof LAB_EVIDENCE_PROVENANCE];

export const LAB_PLATFORMS = ["WEB", "ANDROID", "IOS"] as const;
export type LabPlatform = (typeof LAB_PLATFORMS)[number];

export const LAB_RUNTIMES = [
  "SAFARI",
  "CHROME",
  "EDGE",
  "FIREFOX",
  "SAMSUNG_INTERNET",
  "ANDROID_WEBVIEW",
  "WKWEBVIEW",
  "OTHER",
] as const;
export type LabRuntime = (typeof LAB_RUNTIMES)[number];

export const LAB_DEVICE_CLASSES = ["PHONE", "TABLET", "LAPTOP_DESKTOP", "UNKNOWN"] as const;
export type LabDeviceClass = (typeof LAB_DEVICE_CLASSES)[number];

export const LAB_CAMERA_FACING = ["USER", "ENVIRONMENT", "EXTERNAL", "UNKNOWN"] as const;
export type LabCameraFacing = (typeof LAB_CAMERA_FACING)[number];

export const LAB_CAMERA_ORIENTATIONS = ["PORTRAIT", "LANDSCAPE", "UNKNOWN"] as const;
export type LabCameraOrientation = (typeof LAB_CAMERA_ORIENTATIONS)[number];

export const LAB_INFERENCE_BACKENDS = ["WEBGPU", "WASM", "WEBGL", "NATIVE", "UNKNOWN"] as const;
export type LabInferenceBackend = (typeof LAB_INFERENCE_BACKENDS)[number];

/**
 * Operator/participant-labelled controlled conditions. The lab never infers
 * these from pixels; they are declared labels.
 */
export const LAB_CAPTURE_CONDITIONS = [
  "NORMAL",
  "LOW_LIGHT",
  "BRIGHT_LIGHT",
  "SIDE_LIGHT",
  "POSE_VARIATION",
  "DISTANCE_VARIATION",
  "EXPRESSION_VARIATION",
  "GLASSES",
  "REPEAT_BASELINE",
] as const;
export type LabCaptureCondition = (typeof LAB_CAPTURE_CONDITIONS)[number];

export const LAB_PARTICIPANT_COHORTS = ["GALLERY", "OPEN_SET_HOLDOUT"] as const;
export type LabParticipantCohort = (typeof LAB_PARTICIPANT_COHORTS)[number];

export type LabParticipant = {
  /** Random pseudonym. Never a TrustID, user id, email, or phone number. */
  participantId: string;
  studyId: string;
  studyVersion: string;
  consentVersion: string;
  consentedAt: string;
  /** Hash of the exact consent text shown, so the version is auditable. */
  consentDocumentSha256?: string;
  cohort: LabParticipantCohort;
  createdAt: string;
  status: "ACTIVE" | "WITHDRAWN";
};

export type LabEnvironment = {
  platform: LabPlatform;
  runtime: LabRuntime;
  runtimeVersion?: string;
  deviceClass: LabDeviceClass;
  /** Coarse model string supplied by the operator; optional. */
  deviceModel?: string;
  cameraFacing: LabCameraFacing;
  cameraOrientation: LabCameraOrientation;
  inferenceBackend: LabInferenceBackend;
};

export type LabSession = {
  sessionId: string;
  studyId: string;
  participantId: string;
  protocolSessionKey: string;
  startedAt: string;
  environment: LabEnvironment;
};

export type LabModelRecord = {
  name: string;
  version: number;
  embeddingDimensions: number;
  normalization: "L2";
  distanceMetric: "cosine_distance";
  detectorVersion: string;
  alignmentVersion: string;
  preprocessingVersion: string;
  pipelineVersion: string;
};

export type LabQualityResult = {
  decision: "PASS" | "REJECT";
  score?: number;
  reasons?: string[];
};

export type LabPadResult = {
  decision: "PASS" | "REJECT" | "UNAVAILABLE" | "NOT_RUN";
  method?: string;
  score?: number;
};

/** Canonical per-capture evidence. Contains no embedding and no image. */
export type LabCaptureEvidence = {
  schemaVersion: "trustid_assurance_lab_capture_v1";
  provenance: LabEvidenceProvenance;
  resultKind: "EVALUATION_RESULT";
  studyId: string;
  participantId: string;
  sessionId: string;
  captureId: string;
  protocolSessionKey: string;
  protocolStepKey: string;
  capturedAt: string;
  environment: LabEnvironment;
  conditions: LabCaptureCondition[];
  conditionSource: "OPERATOR_LABEL";
  model: LabModelRecord;
  quality: LabQualityResult;
  pad: LabPadResult;
  latencyMs: {
    detection?: number;
    embedding?: number;
    total: number;
  };
  rawImageRetained: false;
};

/** Stored lab capture: evidence plus the embedding needed for comparisons. */
export type LabCaptureRecord = LabCaptureEvidence & {
  /** L2-normalized production-pipeline embedding. Absent when quality rejected. */
  embedding: number[] | null;
};

export type LabPairRecord = {
  captureA: string;
  captureB: string;
  participantA: string;
  participantB: string;
  genuine: boolean;
  similarity: number;
  distance: number;
  sameSession: boolean;
  crossRuntimeOrDevice: boolean;
  probeConditions: LabCaptureCondition[];
};
