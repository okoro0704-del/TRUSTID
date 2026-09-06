/**
 * Explicit 1:1 verification vs 1:N identification semantics.
 *
 * Distance: cosine distance on L2-normalized 512-D ArcFace embeddings = 1 - dot(u,v).
 * Similarity: cosine similarity = dot(u,v) for unit vectors.
 * Threshold: accept when distance <= policy.threshold (equivalently similarity >= 1 - threshold).
 *
 * 1:1 VERIFY — claimed identity known:
 *   claimed user ? fetch that user's template(s) only ? compare ? threshold ? accept/reject
 *   Never scans the global gallery.
 *
 * 1:N IDENTIFY — identity unknown:
 *   probe ? ANN Top-K candidates ? exact cosine rerank ? threshold ? identity | NO_MATCH
 *   Never accepts nearest neighbor solely because it is nearest.
 *   Never loads the full gallery into Node on ANN failure (fail closed).
 */
import {
  BIOMETRIC_ANN_TOP_K_DEFAULT,
  BIOMETRIC_ANN_TOP_K_OPTIONS,
  BIOMETRIC_MATCH_MODE,
  BIOMETRIC_THRESHOLD_POLICY,
  type BiometricMatchMode,
} from "@trustid/shared";

export type VerificationOneToOneRequest = {
  mode: typeof BIOMETRIC_MATCH_MODE.VERIFY_1_1;
  claimedTrustId: string;
  probe: number[];
};

export type IdentificationOneToNRequest = {
  mode: typeof BIOMETRIC_MATCH_MODE.IDENTIFY_1_N;
  probe: number[];
  /** Candidate count for ANN generation; exact rerank over this set only */
  topK?: (typeof BIOMETRIC_ANN_TOP_K_OPTIONS)[number] | number;
};

export type MatchDecision = {
  mode: BiometricMatchMode;
  matched: boolean;
  distance?: number;
  similarity?: number;
  /** Policy threshold used (cosine distance) */
  thresholdDistance: number;
  thresholdStatus: typeof BIOMETRIC_THRESHOLD_POLICY.status;
  /** For 1:N: how many ANN candidates were considered */
  candidateCount?: number;
  topK?: number;
  rejection:
    | "none"
    | "no_match"
    | "above_threshold"
    | "service_unavailable"
    | "legacy_template"
    | "uncalibrated_gate"
    | "ambiguous";
};

export function resolveTopK(requested?: number): number {
  if (
    requested != null &&
    BIOMETRIC_ANN_TOP_K_OPTIONS.includes(
      requested as (typeof BIOMETRIC_ANN_TOP_K_OPTIONS)[number],
    )
  ) {
    return requested;
  }
  if (requested != null && Number.isFinite(requested) && requested > 0) {
    return Math.min(100, Math.max(1, Math.floor(requested)));
  }
  return BIOMETRIC_ANN_TOP_K_DEFAULT;
}

export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

export function acceptsAtThreshold(
  distance: number,
  thresholdDistance: number,
): boolean {
  return distance <= thresholdDistance;
}

export const MATCH_SEMANTICS_DOC = {
  distanceDefinition:
    "cosine_distance = 1 - dot(L2(probe), L2(template)) on 512-D ArcFace embeddings",
  similarityDefinition: "cosine_similarity = dot(L2(probe), L2(template))",
  thresholdSemantics:
    "Accept only if distance <= thresholdDistance after exact comparison (1:1) or exact rerank of Top-K (1:N). Nearest neighbor alone is insufficient.",
  candidateCountDefault: BIOMETRIC_ANN_TOP_K_DEFAULT,
  candidateCountOptions: [...BIOMETRIC_ANN_TOP_K_OPTIONS],
  noMatchBehavior:
    "Return matched=false with errorCode NO_MATCH when no candidate passes the threshold.",
  serviceUnavailableBehavior:
    "When ANN/pgvector is unavailable or times out, return BIOMETRIC_SERVICE_UNAVAILABLE. Never load the full gallery into application memory.",
  thresholdPolicy: BIOMETRIC_THRESHOLD_POLICY,
} as const;
