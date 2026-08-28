export {
  CIRCUIT_ID,
  PROTOCOL,
  attestKey,
  getVerificationKey,
  proveTrustTierGte,
  signSignals,
  verifyTrustTierGte,
} from "./trust-tier.js";
export type { TrustTierProof } from "./trust-tier.js";

export {
  AUTHORIZATION_CIRCUIT,
  COMPLIANCE_TIER_CIRCUIT,
  UNIQUENESS_CIRCUIT,
  complianceTierFromTrustTierProof,
  proveAuthorization,
  proveClaimBundle,
  proveComplianceTier,
  PAYMENT_STEP_UP_CIRCUIT,
  provePaymentStepUp,
  proveUniqueness,
  verifyZkClaimBundle,
  verifyZkClaimBundles,
} from "./claims.js";

export type {
  Groth16Proof,
  LegacyTrustTierProveResponse,
  ZkClaimBundle,
  ZkClaimType,
  ZkProveBundleResponse,
  ZkVerifyBatchResult,
  ZkVerifyClaimResult,
} from "./types.js";
