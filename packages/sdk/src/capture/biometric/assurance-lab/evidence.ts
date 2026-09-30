import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_PIPELINE_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
} from "@trustid/shared";
import {
  BIOMETRIC_EVIDENCE_CLASS,
  type BiometricEvaluationTrial,
} from "../evaluation/contract.js";
import { findProtocolStep, type LabStudyConfig } from "./protocol.js";
import {
  LAB_EVIDENCE_PROVENANCE,
  type LabCaptureCondition,
  type LabCaptureEvidence,
  type LabCaptureRecord,
  type LabEnvironment,
  type LabEvidenceProvenance,
  type LabModelRecord,
  type LabPadResult,
  type LabPairRecord,
  type LabQualityResult,
  type LabSession,
} from "./types.js";

export const LAB_PRODUCTION_MODEL: LabModelRecord = {
  name: BIOMETRIC_AI_MODEL_NAME,
  version: BIOMETRIC_AI_MODEL_VERSION,
  embeddingDimensions: BIOMETRIC_AI_EMBEDDING_DIMS,
  normalization: "L2",
  distanceMetric: "cosine_distance",
  detectorVersion: BIOMETRIC_DETECTOR_VERSION,
  alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
  preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
  pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
};

const L2_TOLERANCE = 1e-3;

export class LabEvidenceError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_PROTOCOL_STEP"
      | "CONDITION_NOT_ALLOWED"
      | "CONDITIONS_REQUIRED"
      | "MODEL_MISMATCH"
      | "EMBEDDING_REQUIRED"
      | "EMBEDDING_DIMENSIONS"
      | "EMBEDDING_NOT_FINITE"
      | "EMBEDDING_NOT_L2_NORMALIZED"
      | "EMBEDDING_FORBIDDEN_ON_QUALITY_REJECT"
      | "EVIDENCE_CLASSES_MIXED",
    message: string,
  ) {
    super(message);
  }
}

export type LabCaptureInput = {
  provenance: LabEvidenceProvenance;
  captureId: string;
  capturedAt: string;
  protocolStepKey: string;
  conditions: LabCaptureCondition[];
  model: Omit<LabModelRecord, "normalization" | "distanceMetric"> & {
    normalization?: string;
    distanceMetric?: string;
  };
  quality: LabQualityResult;
  pad: LabPadResult;
  latencyMs: LabCaptureEvidence["latencyMs"];
  embedding: number[] | null;
};

function assertProductionModel(model: LabCaptureInput["model"]): void {
  const p = LAB_PRODUCTION_MODEL;
  const mismatches: string[] = [];
  if (model.name !== p.name) mismatches.push("name");
  if (model.version !== p.version) mismatches.push("version");
  if (model.embeddingDimensions !== p.embeddingDimensions) mismatches.push("embeddingDimensions");
  if (model.detectorVersion !== p.detectorVersion) mismatches.push("detectorVersion");
  if (model.alignmentVersion !== p.alignmentVersion) mismatches.push("alignmentVersion");
  if (model.preprocessingVersion !== p.preprocessingVersion) mismatches.push("preprocessingVersion");
  if (model.pipelineVersion !== p.pipelineVersion) mismatches.push("pipelineVersion");
  if (model.normalization != null && model.normalization !== "L2") mismatches.push("normalization");
  if (model.distanceMetric != null && model.distanceMetric !== "cosine_distance") {
    mismatches.push("distanceMetric");
  }
  if (mismatches.length) {
    throw new LabEvidenceError(
      "MODEL_MISMATCH",
      `Capture was not produced by the production pipeline (${mismatches.join(", ")}).`,
    );
  }
}

function assertUnitEmbedding(embedding: number[]): void {
  if (embedding.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    throw new LabEvidenceError(
      "EMBEDDING_DIMENSIONS",
      `Expected ${BIOMETRIC_AI_EMBEDDING_DIMS} dimensions, got ${embedding.length}.`,
    );
  }
  let sum = 0;
  for (const x of embedding) {
    if (!Number.isFinite(x)) {
      throw new LabEvidenceError("EMBEDDING_NOT_FINITE", "Embedding contains non-finite values.");
    }
    sum += x * x;
  }
  if (Math.abs(Math.sqrt(sum) - 1) > L2_TOLERANCE) {
    throw new LabEvidenceError(
      "EMBEDDING_NOT_L2_NORMALIZED",
      "Embedding is not L2-normalized; the lab records pipeline output as produced.",
    );
  }
}

/**
 * Build the stored capture record. Rejects anything that is not the production
 * pipeline's output, so lab evidence always describes the deployed model.
 */
export function buildLabCaptureRecord(
  study: LabStudyConfig,
  session: LabSession,
  input: LabCaptureInput,
): LabCaptureRecord {
  const found = findProtocolStep(study, session.protocolSessionKey, input.protocolStepKey);
  if (!found) {
    throw new LabEvidenceError(
      "UNKNOWN_PROTOCOL_STEP",
      `Step ${input.protocolStepKey} is not part of ${session.protocolSessionKey}.`,
    );
  }
  if (!input.conditions.length) {
    throw new LabEvidenceError("CONDITIONS_REQUIRED", "Label at least one capture condition.");
  }
  for (const c of input.conditions) {
    if (!found.step.allowedConditions.includes(c)) {
      throw new LabEvidenceError(
        "CONDITION_NOT_ALLOWED",
        `Condition ${c} is not allowed in step ${found.step.key}.`,
      );
    }
  }
  assertProductionModel(input.model);

  if (input.quality.decision === "PASS") {
    if (!input.embedding) {
      throw new LabEvidenceError("EMBEDDING_REQUIRED", "A quality-passing capture must carry its embedding.");
    }
    assertUnitEmbedding(input.embedding);
  } else if (input.embedding) {
    throw new LabEvidenceError(
      "EMBEDDING_FORBIDDEN_ON_QUALITY_REJECT",
      "Quality-rejected captures are recorded as failure-to-acquire without an embedding.",
    );
  }

  return {
    schemaVersion: "trustid_assurance_lab_capture_v1",
    provenance: input.provenance,
    resultKind: "EVALUATION_RESULT",
    studyId: study.studyId,
    participantId: session.participantId,
    sessionId: session.sessionId,
    captureId: input.captureId,
    protocolSessionKey: session.protocolSessionKey,
    protocolStepKey: input.protocolStepKey,
    capturedAt: input.capturedAt,
    environment: { ...session.environment },
    conditions: [...input.conditions],
    conditionSource: "OPERATOR_LABEL",
    model: { ...LAB_PRODUCTION_MODEL },
    quality: { ...input.quality },
    pad: { ...input.pad },
    latencyMs: { ...input.latencyMs },
    rawImageRetained: false,
    embedding: input.embedding ? [...input.embedding] : null,
  };
}

/** Public evidence view: never includes the embedding. */
export function toCaptureEvidence(record: LabCaptureRecord): LabCaptureEvidence {
  const { embedding: _embedding, ...evidence } = record;
  void _embedding;
  return evidence;
}

/** Real-human and synthetic evidence must never be analysed together. */
export function assertSingleEvidenceClass(
  records: Array<{ provenance: LabEvidenceProvenance }>,
): LabEvidenceProvenance | null {
  const classes = new Set(records.map((r) => r.provenance));
  if (classes.size > 1) {
    throw new LabEvidenceError(
      "EVIDENCE_CLASSES_MIXED",
      "REAL_HUMAN_CONSENTED and SYNTHETIC evidence cannot be combined in one analysis.",
    );
  }
  return records[0]?.provenance ?? null;
}

function contractBrowser(env: LabEnvironment): BiometricEvaluationTrial["environment"]["browser"] {
  if (env.runtime === "SAFARI") return "Safari";
  if (env.runtime === "CHROME") return "Chrome";
  if (env.runtime === "EDGE") return "Edge";
  return "Other";
}

function contractPlatform(env: LabEnvironment): BiometricEvaluationTrial["environment"]["platform"] {
  if (env.platform === "ANDROID") return "Android";
  if (env.platform === "IOS") return "iOS";
  return "Web";
}

function contractDeviceClass(
  env: LabEnvironment,
): BiometricEvaluationTrial["environment"]["deviceClass"] {
  if (env.deviceClass === "PHONE") return "phone";
  if (env.deviceClass === "TABLET") return "tablet";
  if (env.deviceClass === "LAPTOP_DESKTOP") return "laptop_desktop";
  return "unknown";
}

/**
 * Express one lab 1:1 comparison as a canonical evaluation trial so lab output
 * is consumed by the existing evaluation contract, not a parallel format.
 */
export function pairToEvaluationTrial(input: {
  runId: string;
  pair: LabPairRecord;
  enrollment: LabCaptureRecord;
  probe: LabCaptureRecord;
  thresholdDistance: number;
  accepted: boolean;
}): BiometricEvaluationTrial {
  const { pair, enrollment, probe } = input;
  const conditions = probe.conditions;
  return {
    schemaVersion: "trustid_biometric_evaluation_trial_v1",
    runId: input.runId,
    trialId: `${pair.captureA}:${pair.captureB}`,
    timestamp: probe.capturedAt,
    evidenceClass:
      probe.provenance === LAB_EVIDENCE_PROVENANCE.REAL_HUMAN_CONSENTED
        ? BIOMETRIC_EVIDENCE_CLASS.REAL_HUMAN
        : BIOMETRIC_EVIDENCE_CLASS.SYNTHETIC_FIXTURE,
    operation: "VERIFY_1_1",
    enrollmentSampleId: enrollment.captureId,
    probeSampleId: probe.captureId,
    enrollmentSubjectId: enrollment.participantId,
    probeSubjectId: probe.participantId,
    expectedRelationship: pair.genuine ? "GENUINE" : "IMPOSTOR",
    environment: {
      browser: contractBrowser(probe.environment),
      platform: contractPlatform(probe.environment),
      deviceClass: contractDeviceClass(probe.environment),
      deviceModel: probe.environment.deviceModel,
    },
    captureConditions: {
      lighting: conditions.find((c) => c.endsWith("_LIGHT")),
      pose: conditions.includes("POSE_VARIATION") ? "POSE_VARIATION" : undefined,
      distance: conditions.includes("DISTANCE_VARIATION") ? "DISTANCE_VARIATION" : undefined,
      expression: conditions.includes("EXPRESSION_VARIATION") ? "EXPRESSION_VARIATION" : undefined,
      glasses: conditions.includes("GLASSES") ? "GLASSES" : undefined,
      sessionId: probe.sessionId,
      tags: [...conditions],
    },
    model: {
      name: probe.model.name,
      version: probe.model.version,
      embeddingDimensions: probe.model.embeddingDimensions,
      preprocessingVersion: probe.model.preprocessingVersion,
      normalization: "L2",
      distanceMetric: "cosine_distance",
    },
    score: { distance: pair.distance, similarity: 1 - pair.distance },
    quality: probe.quality,
    pad: probe.pad,
    actualDecision: input.accepted ? "MATCH" : "NO_MATCH",
    thresholdDistance: input.thresholdDistance,
    latencyMs: { total: probe.latencyMs.total, embedding: probe.latencyMs.embedding },
  };
}
