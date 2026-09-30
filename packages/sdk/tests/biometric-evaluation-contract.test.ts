import { describe, expect, it } from "vitest";
import {
  BIOMETRIC_EVIDENCE_CLASS,
  BIOMETRIC_EVALUATION_DECISION,
  validateBiometricEvaluationTrial,
  type BiometricEvaluationTrial,
} from "../src/capture/biometric/evaluation/index.js";
import { computeIdentificationDecisionMetrics } from "../src/capture/biometric/benchmark/index.js";

function trial(overrides: Partial<BiometricEvaluationTrial> = {}): BiometricEvaluationTrial {
  return {
    schemaVersion: "trustid_biometric_evaluation_trial_v1",
    runId: "run-1",
    trialId: "trial-1",
    timestamp: "2026-09-28T00:00:00.000Z",
    evidenceClass: BIOMETRIC_EVIDENCE_CLASS.SYNTHETIC_FIXTURE,
    operation: "VERIFY_1_1",
    enrollmentSampleId: "enroll-1",
    probeSampleId: "probe-1",
    enrollmentSubjectId: "subject-1",
    probeSubjectId: "subject-1",
    expectedRelationship: "GENUINE",
    environment: { browser: "Safari", platform: "Web", deviceClass: "phone" },
    captureConditions: { lighting: "indoor", sessionId: "session-2" },
    model: {
      name: "insightface_arcface_w600k_mbf_v1",
      version: 1,
      embeddingDimensions: 512,
      preprocessingVersion: "arcface_112_rgb_v1",
      normalization: "L2",
      distanceMetric: "cosine_distance",
    },
    score: { distance: 0.1, similarity: 0.9 },
    quality: { decision: "PASS", score: 0.9 },
    pad: { decision: "PASS", method: "active_blink_liveness" },
    actualDecision: BIOMETRIC_EVALUATION_DECISION.MATCH,
    thresholdDistance: 0.35,
    latencyMs: { candidateRetrieval: 2, reranking: 1, total: 3 },
    ...overrides,
  };
}

describe("biometric evaluation contract", () => {
  it("records the required provenance and does not treat fixtures as accuracy evidence", () => {
    const result = validateBiometricEvaluationTrial(trial());
    expect(result.valid).toBe(true);
    expect(result.biometricAccuracyClaimAllowed).toBe(false);
  });

  it("rejects inconsistent distance/similarity and incomplete labeled trials", () => {
    const result = validateBiometricEvaluationTrial(
      trial({ score: { distance: 0.2, similarity: 0.9 }, enrollmentSubjectId: undefined }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("similarity must equal 1 - distance");
    expect(result.errors).toContain("enrollmentSubjectId is required for genuine/impostor trials");
  });

  it("computes candidate recall, ambiguity, no-match, and latency without relabeling synthetic evidence", () => {
    const report = computeIdentificationDecisionMetrics([
      {
        evidenceClass: "SYNTHETIC_FIXTURE",
        expectedIdentityId: "a",
        candidateIdentityIds: ["b", "a"],
        decision: "AMBIGUOUS",
        latencyMs: { candidateRetrieval: 4, reranking: 1, total: 5 },
      },
      {
        evidenceClass: "SYNTHETIC_FIXTURE",
        expectedIdentityId: null,
        candidateIdentityIds: [],
        decision: "NO_MATCH",
        latencyMs: { candidateRetrieval: 6, reranking: 1, total: 7 },
      },
    ], [1, 5]);
    expect(report.candidateRecallAtK.K_1).toBe(0);
    expect(report.candidateRecallAtK.K_5).toBe(1);
    expect(report.ambiguousRate).toBe(0.5);
    expect(report.noMatchRate).toBe(0.5);
    expect(report.biometricAccuracyStatus).toBe("SYNTHETIC_INFRA_ONLY");
    expect(report.latencyMs.total.p95).toBe(7);
  });
});
