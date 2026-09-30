import { describe, expect, it } from "vitest";
import {
  BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_THRESHOLD_POLICY,
} from "@trustid/shared";
import { decideAfterRerank, exactRerankCandidates } from "../src/modules/trust-id/ann-rerank.js";
import {
  assessDuplicateEnrollmentCandidates,
  DUPLICATE_ENROLLMENT_DECISION,
  unavailableDuplicateEnrollmentAssessment,
} from "../src/modules/trust-id/duplicate-enrollment.js";
import { biometricPayloadSchema } from "../src/modules/trust-id/schemas.js";
import { face512, facePayload } from "./helpers/face.js";

describe("biometric assurance foundation policy", () => {
  it("fails closed when two distinct identities pass threshold within ambiguity margin", () => {
    const ranked = exactRerankCandidates(face512(1), [
      { embeddingId: "e1", userId: "u1", trustId: "T1", annDistance: 0.1 },
      { embeddingId: "e2", userId: "u2", trustId: "T2", annDistance: 0.11 },
    ]);
    const decision = decideAfterRerank(
      ranked,
      BIOMETRIC_THRESHOLD_POLICY.threshold,
      BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
    );
    expect(decision.reason).toBe("ambiguous");
    expect(decision.accepted).toBeNull();
  });

  it("does not treat multiple templates for one identity as ambiguity", () => {
    const ranked = exactRerankCandidates(face512(1), [
      { embeddingId: "e1", userId: "u1", trustId: "T1", annDistance: 0.1 },
      { embeddingId: "e2", userId: "u1", trustId: "T1", annDistance: 0.11 },
    ]);
    expect(decideAfterRerank(ranked, 0.35, 0.02).reason).toBe("accept");
  });

  it("requires review for a duplicate candidate and never auto-merges", () => {
    const assessment = assessDuplicateEnrollmentCandidates([
      { embeddingId: "e1", userId: "u1", trustId: "T1", distance: 0.1, similarity: 0.9, rank: 1 },
    ]);
    expect(assessment.decision).toBe(DUPLICATE_ENROLLMENT_DECISION.REVIEW_REQUIRED);
    expect(assessment.canAutoCreate).toBe(false);
    expect(assessment.candidateTrustIds).toEqual(["T1"]);
  });

  it("blocks automatic enrollment when duplicate search is unavailable", () => {
    const assessment = unavailableDuplicateEnrollmentAssessment();
    expect(assessment.decision).toBe(DUPLICATE_ENROLLMENT_DECISION.SERVICE_UNAVAILABLE);
    expect(assessment.canAutoCreate).toBe(false);
  });

  it("rejects malformed and wrong-dimension vectors and strips caller threshold/score fields", () => {
    expect(() => biometricPayloadSchema.parse({ ...facePayload(1), vector: [1, 2] })).toThrow();
    const parsed = biometricPayloadSchema.parse({
      ...facePayload(1),
      threshold: -1,
      claimedScore: 1,
      padDecision: "PASS",
    });
    expect("threshold" in parsed).toBe(false);
    expect("claimedScore" in parsed).toBe(false);
    expect("padDecision" in parsed).toBe(false);
    expect(BIOMETRIC_ERROR_CODES.AMBIGUOUS_MATCH).toBe("AMBIGUOUS_MATCH");
  });
});
