/** Canonical record for one biometric evaluation decision. */
export const BIOMETRIC_EVIDENCE_CLASS = {
  REAL_HUMAN: "REAL_HUMAN",
  SYNTHETIC_FIXTURE: "SYNTHETIC_FIXTURE",
} as const;

export const BIOMETRIC_EVALUATION_DECISION = {
  MATCH: "MATCH",
  NO_MATCH: "NO_MATCH",
  AMBIGUOUS: "AMBIGUOUS",
  QUALITY_REJECTED: "QUALITY_REJECTED",
  PAD_REJECTED: "PAD_REJECTED",
  NO_FACE: "NO_FACE",
  MULTIPLE_FACES: "MULTIPLE_FACES",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type BiometricEvaluationDecision =
  (typeof BIOMETRIC_EVALUATION_DECISION)[keyof typeof BIOMETRIC_EVALUATION_DECISION];

export type BiometricEvaluationTrial = {
  schemaVersion: "trustid_biometric_evaluation_trial_v1";
  runId: string;
  trialId: string;
  timestamp: string;
  evidenceClass:
    | typeof BIOMETRIC_EVIDENCE_CLASS.REAL_HUMAN
    | typeof BIOMETRIC_EVIDENCE_CLASS.SYNTHETIC_FIXTURE;
  operation: "VERIFY_1_1" | "IDENTIFY_1_N" | "DUPLICATE_ENROLLMENT";
  enrollmentSampleId?: string;
  probeSampleId: string;
  enrollmentSubjectId?: string;
  probeSubjectId: string;
  expectedRelationship: "GENUINE" | "IMPOSTOR" | "OPEN_SET_UNKNOWN";
  environment: {
    browser: "Safari" | "Chrome" | "Edge" | "Other";
    platform: "Web" | "Android" | "iOS";
    deviceClass: "phone" | "tablet" | "laptop_desktop" | "unknown";
    deviceModel?: string;
    cameraId?: string;
  };
  captureConditions: {
    lighting?: string;
    pose?: string;
    distance?: string;
    expression?: string;
    glasses?: string;
    sessionId?: string;
    tags?: string[];
  };
  model: {
    name: string;
    version: number;
    embeddingDimensions: number;
    preprocessingVersion: string;
    normalization: "L2";
    distanceMetric: "cosine_distance";
  };
  score: { distance: number; similarity: number } | null;
  quality: { decision: "PASS" | "REJECT"; score?: number; reasons?: string[] };
  pad: {
    decision: "PASS" | "REJECT" | "UNAVAILABLE" | "NOT_RUN";
    method?: string;
    score?: number;
  };
  actualDecision: BiometricEvaluationDecision;
  thresholdDistance: number;
  candidateCount?: number;
  candidateRanks?: Array<{ identityId: string; rank: number; distance: number }>;
  latencyMs?: {
    capture?: number;
    embedding?: number;
    candidateRetrieval?: number;
    reranking?: number;
    total: number;
  };
};

export type EvaluationContractValidation = {
  valid: boolean;
  errors: string[];
  biometricAccuracyClaimAllowed: boolean;
};

/**
 * Structural validation only. REAL_HUMAN labels permit later accuracy analysis;
 * this function never claims that consent, labels, or capture provenance are true.
 */
export function validateBiometricEvaluationTrial(
  trial: BiometricEvaluationTrial,
): EvaluationContractValidation {
  const errors: string[] = [];
  if (!trial.runId.trim()) errors.push("runId is required");
  if (!trial.trialId.trim()) errors.push("trialId is required");
  if (!trial.probeSampleId.trim()) errors.push("probeSampleId is required");
  if (!trial.probeSubjectId.trim()) errors.push("probeSubjectId is required");
  if (!Number.isFinite(Date.parse(trial.timestamp))) errors.push("timestamp must be ISO-8601");
  if (!Number.isFinite(trial.thresholdDistance)) errors.push("thresholdDistance must be finite");
  if (trial.model.embeddingDimensions <= 0) errors.push("embeddingDimensions must be positive");
  if (trial.score) {
    if (!Number.isFinite(trial.score.distance) || !Number.isFinite(trial.score.similarity)) {
      errors.push("score values must be finite");
    } else if (Math.abs(1 - trial.score.distance - trial.score.similarity) > 1e-6) {
      errors.push("similarity must equal 1 - distance");
    }
  }
  if (
    trial.expectedRelationship !== "OPEN_SET_UNKNOWN" &&
    !trial.enrollmentSubjectId
  ) {
    errors.push("enrollmentSubjectId is required for genuine/impostor trials");
  }
  return {
    valid: errors.length === 0,
    errors,
    biometricAccuracyClaimAllowed:
      errors.length === 0 &&
      trial.evidenceClass === BIOMETRIC_EVIDENCE_CLASS.REAL_HUMAN,
  };
}
