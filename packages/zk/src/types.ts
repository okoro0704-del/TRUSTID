import type { TrustTierProof } from "./trust-tier.js";

/** LifeOS-compatible claim identifiers. */
export type ZkClaimType =
  | "compliance_tier"
  | "uniqueness"
  | "authorization"
  | "payment_step_up"
  | "identity_status"
  | "trust_tier_gte";

/** Groth16-shaped proof JSON (hybrid attestation embedded when present). */
export type Groth16Proof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
  /** Hybrid HMAC attestation over publicSignals (TrustID extension). */
  attestation?: string;
};

/** Zero-knowledge claim bundle ù no raw PII. */
export type ZkClaimBundle = {
  claimType: ZkClaimType;
  proof: Groth16Proof;
  publicSignals: string[];
  nullifier?: string;
  disclosed?: {
    trustTier?: number;
    identityStatus?: string;
    verified?: boolean;
    authorized?: boolean;
  };
  issuedAt?: string;
  audience?: string;
  protocol?: "groth16";
};

export type ZkProveBundleResponse = {
  claims: ZkClaimBundle[];
  issuedAt: number;
  audience: string;
};

export type ZkVerifyClaimResult = {
  valid: boolean;
  claimType?: ZkClaimType;
  reason?: string;
};

export type ZkVerifyBatchResult = {
  valid: boolean;
  results: ZkVerifyClaimResult[];
};

/** Legacy single-claim prove response (backward compatible). */
export type LegacyTrustTierProveResponse = TrustTierProof & {
  trustIdNullifier: string;
  stars: number;
  maxStars: number;
  label: string;
};
