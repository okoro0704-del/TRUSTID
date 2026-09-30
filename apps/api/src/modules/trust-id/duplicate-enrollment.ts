import {
  BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
  BIOMETRIC_THRESHOLD_POLICY,
} from "@trustid/shared";
import type { RerankResult } from "./ann-rerank.js";

export const DUPLICATE_ENROLLMENT_DECISION = {
  CLEAR: "CLEAR",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  AMBIGUOUS: "AMBIGUOUS",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type DuplicateEnrollmentAssessment = {
  decision:
    | typeof DUPLICATE_ENROLLMENT_DECISION.CLEAR
    | typeof DUPLICATE_ENROLLMENT_DECISION.REVIEW_REQUIRED
    | typeof DUPLICATE_ENROLLMENT_DECISION.AMBIGUOUS
    | typeof DUPLICATE_ENROLLMENT_DECISION.SERVICE_UNAVAILABLE;
  canAutoCreate: boolean;
  candidateCount: number;
  /** Internal references only; never return vectors or auto-merge accounts. */
  candidateTrustIds: string[];
  reason: string;
};

/**
 * Duplicate enrollment is a separate decision from login. A close candidate
 * blocks automatic creation and requires an established account recovery,
 * stronger verification, or manual review path. ANN proximity never merges.
 */
export function assessDuplicateEnrollmentCandidates(
  ranked: RerankResult[],
  thresholdDistance: number = BIOMETRIC_THRESHOLD_POLICY.threshold,
  ambiguityMarginDistance: number = BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
): DuplicateEnrollmentAssessment {
  const passing = ranked.filter((candidate) => candidate.distance <= thresholdDistance);
  if (passing.length === 0) {
    return {
      decision: DUPLICATE_ENROLLMENT_DECISION.CLEAR,
      canAutoCreate: true,
      candidateCount: 0,
      candidateTrustIds: [],
      reason: "no_existing_candidate_passed_threshold",
    };
  }

  const distinct = [...new Map(passing.map((candidate) => [candidate.userId, candidate])).values()];
  const best = distinct[0]!;
  const second = distinct[1];
  const ambiguous = Boolean(
    second && second.distance - best.distance <= ambiguityMarginDistance,
  );
  return {
    decision: ambiguous
      ? DUPLICATE_ENROLLMENT_DECISION.AMBIGUOUS
      : DUPLICATE_ENROLLMENT_DECISION.REVIEW_REQUIRED,
    canAutoCreate: false,
    candidateCount: distinct.length,
    candidateTrustIds: distinct.map((candidate) => candidate.trustId),
    reason: ambiguous
      ? "multiple_close_existing_identities_require_review"
      : "existing_identity_candidate_requires_stronger_verification",
  };
}

export function unavailableDuplicateEnrollmentAssessment(
  reason = "candidate_search_unavailable",
): DuplicateEnrollmentAssessment {
  return {
    decision: DUPLICATE_ENROLLMENT_DECISION.SERVICE_UNAVAILABLE,
    canAutoCreate: false,
    candidateCount: 0,
    candidateTrustIds: [],
    reason,
  };
}
