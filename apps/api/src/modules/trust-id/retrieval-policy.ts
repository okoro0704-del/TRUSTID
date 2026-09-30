/**
 * Biometric retrieval governance: the production ANN retrieval policy as one
 * explicit, read-only object. Values are resolved exactly as the production
 * matcher resolves them (declared default -> environment override -> rule).
 *
 * This module never changes any setting. It reports what is declared, what the
 * environment makes effective, and whether the production query path actually
 * applies each session setting. It contains no biometric data.
 *
 * The ef_search / timeout resolution mirrors the private resolvers in
 * vector-matcher.ts; tests/retrieval-policy.test.ts pins both against drift.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
  BIOMETRIC_ANN_QUERY_TIMEOUT_MS,
  BIOMETRIC_ANN_TOP_K_DEFAULT,
  BIOMETRIC_ANN_TOP_K_OPTIONS,
  BIOMETRIC_HNSW_EF_SEARCH_DEFAULT,
  BIOMETRIC_THRESHOLD_POLICY,
} from "@trustid/shared";
import { DUPLICATE_ENROLLMENT_DECISION } from "./duplicate-enrollment.js";
import { resolveTopK } from "./match-semantics.js";

export const RETRIEVAL_POLICY_SCHEMA_VERSION = "trustid_biometric_retrieval_policy_v1";

/** Production HNSW build parameters (pgvector_setup.sql / lib/pgvector.ts). */
export const PRODUCTION_HNSW_INDEX = { type: "hnsw", m: 16, efConstruction: 64, opclass: "vector_cosine_ops" } as const;

/**
 * How the production 1:N query path (vector-matcher.ts fetchAnnTopK) applies
 * its per-query session settings. It issues `SET LOCAL statement_timeout` and
 * `set_config('hnsw.ef_search', <ef>, true)` as separate autocommit statements,
 * not inside a transaction with the search. Transaction-local settings end with
 * their own statement, so neither reaches the search query: the search runs
 * with the database/role defaults (pgvector hnsw.ef_search default is 40, and
 * with LIMIT 50 > ef_search HNSW returns at most ef_search rows).
 */
export const ANN_SESSION_SETTING_APPLICATION = {
  status: "NOT_APPLIED_OUTSIDE_TRANSACTION",
  codePath: "apps/api/src/modules/trust-id/vector-matcher.ts fetchAnnTopK",
  effect:
    "Declared ef_search and ANN statement timeout do not reach the search query; the database/role default applies.",
  productionChange: "NONE. Reported for a governance decision; not changed by this module.",
} as const;

function envOverride(variable: string) {
  const raw = process.env[variable];
  return { variable, present: raw != null && raw !== "" };
}

function positiveEnvNumber(variable: string): number | null {
  const raw = process.env[variable];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function effectiveTopK(): number {
  const raw = process.env.BIOMETRIC_ANN_TOP_K;
  return raw != null && raw !== "" ? resolveTopK(Number(raw)) : resolveTopK();
}

function effectiveEfSearch(topK: number): number {
  return Math.max(positiveEnvNumber("BIOMETRIC_HNSW_EF_SEARCH") ?? BIOMETRIC_HNSW_EF_SEARCH_DEFAULT, topK);
}

/** Declared and environment-effective policy. Pure; no database access. */
export function biometricRetrievalPolicy() {
  const topK = effectiveTopK();
  const thresholdOverride = positiveEnvNumber("FAST_VECTOR_MAX_DISTANCE");
  return {
    schemaVersion: RETRIEVAL_POLICY_SCHEMA_VERSION,
    readOnly: true as const,
    containsBiometricData: false as const,
    model: {
      name: BIOMETRIC_AI_MODEL_NAME,
      version: BIOMETRIC_AI_MODEL_VERSION,
      dimensions: BIOMETRIC_AI_EMBEDDING_DIMS,
      normalization: "L2" as const,
      metric: "cosine_distance" as const,
    },
    index: PRODUCTION_HNSW_INDEX,
    topK: {
      declaredDefault: BIOMETRIC_ANN_TOP_K_DEFAULT,
      allowed: [...BIOMETRIC_ANN_TOP_K_OPTIONS],
      effective: topK,
      override: envOverride("BIOMETRIC_ANN_TOP_K"),
    },
    efSearch: {
      declaredDefault: BIOMETRIC_HNSW_EF_SEARCH_DEFAULT,
      rule: "max(BIOMETRIC_HNSW_EF_SEARCH or 64, topK)",
      declaredEffective: effectiveEfSearch(topK),
      override: envOverride("BIOMETRIC_HNSW_EF_SEARCH"),
      application: ANN_SESSION_SETTING_APPLICATION,
    },
    annQueryTimeoutMs: {
      declaredDefault: BIOMETRIC_ANN_QUERY_TIMEOUT_MS,
      declaredEffective: positiveEnvNumber("BIOMETRIC_ANN_QUERY_TIMEOUT_MS") ?? BIOMETRIC_ANN_QUERY_TIMEOUT_MS,
      override: envOverride("BIOMETRIC_ANN_QUERY_TIMEOUT_MS"),
      application: ANN_SESSION_SETTING_APPLICATION,
    },
    threshold: {
      policyDistance: BIOMETRIC_THRESHOLD_POLICY.threshold,
      effectiveDistance: thresholdOverride ?? BIOMETRIC_THRESHOLD_POLICY.threshold,
      status: BIOMETRIC_THRESHOLD_POLICY.status,
      override: envOverride("FAST_VECTOR_MAX_DISTANCE"),
      requireCalibrated: process.env.BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD === "true",
    },
    ambiguityMarginDistance: BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
    duplicateGate: {
      decisions: Object.values(DUPLICATE_ENROLLMENT_DECISION),
      onlyClearCreates: true as const,
    },
    governance: {
      changeProcess:
        "Retrieval parameters change only through a reviewed code/config change backed by real consented lab evidence. Lab results never apply themselves.",
      writableFromThisSurface: false as const,
    },
  };
}

export type BiometricRetrievalPolicy = ReturnType<typeof biometricRetrievalPolicy>;
