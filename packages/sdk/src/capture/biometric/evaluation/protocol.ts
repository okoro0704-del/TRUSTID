/**
 * Internal biometric evaluation collection protocol.
 * NOT production enrollment. Uses the same ArcFace pipeline constants.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_PIPELINE_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
} from "@trustid/shared";

export const EVAL_DATASET_NAME = "trustid_lab_v1";
export const EVAL_DATASET_VERSION = "1.0.0";
export const EVAL_MIN_ACCEPTED_PER_SESSION = 3;
export const EVAL_MAX_IMAGE_BYTES = 2_500_000;

/** Distinct sessions — not one continuous camera stream. */
export const EVAL_SESSION_PROTOCOL = [
  {
    key: "enrollment_neutral",
    title: "Session 1 — Enrollment (neutral)",
    guidance:
      "Sit in normal indoor light. Look straight at the camera. Neutral expression. Capture at least 3 good frames.",
    conditionTags: ["neutral", "indoor_lighting"] as const,
  },
  {
    key: "lighting_and_expression",
    title: "Session 2 — Lighting / expression",
    guidance:
      "After a short break, vary lighting slightly (face a window or turn a lamp) and use a natural smile or soft expression. At least 3 good frames.",
    conditionTags: ["lighting_variation", "expression_variation"] as const,
  },
  {
    key: "pose_and_distance",
    title: "Session 3 — Pose / distance",
    guidance:
      "After another break, sit slightly closer or farther and turn your head a little left/right (still facing the camera). Glasses on/off if you wear them. At least 3 good frames.",
    conditionTags: ["pose_variation", "distance_variation"] as const,
  },
] as const;

export type EvalSessionKey = (typeof EVAL_SESSION_PROTOCOL)[number]["key"];

export const EVAL_PIPELINE_RECORD = {
  modelName: BIOMETRIC_AI_MODEL_NAME,
  modelVersion: BIOMETRIC_AI_MODEL_VERSION,
  detectorVersion: BIOMETRIC_DETECTOR_VERSION,
  alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
  preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
  pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
  embeddingDims: BIOMETRIC_AI_EMBEDDING_DIMS,
  normalization: "L2",
  distanceMetric: "cosine_distance",
} as const;

export type EvalConsentRecord = {
  consent_given: true;
  consent_timestamp: string;
  dataset_version: string;
};

export type EvalCaptureRecord = {
  sampleId: string;
  subject_id: string;
  sessionId: string;
  sessionKey: EvalSessionKey;
  captureId: string;
  timestamp: string;
  qualityScore?: number;
  conditionTags?: string[];
  active_liveness_check?: "passed" | "skipped" | "failed";
  embedding: number[];
  imagePath?: string;
  imageSha256?: string;
  pipeline: typeof EVAL_PIPELINE_RECORD;
};

export type EvalParticipantMeta = {
  subject_id: string;
  created_at: string;
  consent: EvalConsentRecord;
  status: "active" | "deleted";
};

export type EvalManifest = {
  dataset_id: string;
  dataset_version: string;
  name: string;
  created_at: string;
  purpose: "INTERNAL_BIOMETRIC_EVALUATION_NOT_PRODUCTION_ENROLLMENT";
  pipeline: typeof EVAL_PIPELINE_RECORD;
  subject_count: number;
  session_count: number;
  image_count: number;
  capture_count: number;
  consented_participants: number;
};

export type LabeledExportSample = {
  sampleId: string;
  subject_id: string;
  identityId: string;
  sessionId: string;
  split: "development" | "validation" | "test";
  imagePath?: string;
  imageSha256?: string;
  embedding: number[];
  failureModes?: string[];
  qualityScore?: number;
};

export type LabeledExportConsentParticipant = {
  subject_id: string;
  consent_given: true;
  consent_timestamp: string;
  dataset_version: string;
};

export type LabeledExportDataset = {
  name: string;
  datasetVersion: string;
  modelName: string;
  modelVersion: number;
  pipelineVersion: string;
  embeddingDims: number;
  /** Consent records for every subject represented in samples */
  consent_attestation?: {
    all_subjects_consented: boolean;
    participants: LabeledExportConsentParticipant[];
  };
  samples: LabeledExportSample[];
};
