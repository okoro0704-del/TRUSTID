import { createHash, timingSafeEqual } from "node:crypto";
import {
  proveTrustTierGte,
  signSignals,
  verifyTrustTierGte,
  type TrustTierProof,
} from "./trust-tier.js";
import type {
  Groth16Proof,
  ZkClaimBundle,
  ZkClaimType,
  ZkVerifyBatchResult,
  ZkVerifyClaimResult,
} from "./types.js";

export const COMPLIANCE_TIER_CIRCUIT = "compliance_tier_v1";
export const UNIQUENESS_CIRCUIT = "uniqueness_v1";
export const AUTHORIZATION_CIRCUIT = "authorization_v1";
export const PAYMENT_STEP_UP_CIRCUIT = "payment_step_up_v1";

function hashToBigIntString(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`).toString();
}

function groth16ShapeFromAttestation(attestation: string, protocol: string): Groth16Proof {
  return {
    pi_a: [attestation.slice(0, 32), attestation.slice(32, 64), "1"],
    pi_b: [
      [attestation.slice(0, 16), attestation.slice(16, 32)],
      [attestation.slice(32, 48), attestation.slice(48, 64)],
      ["1", "0"],
    ],
    pi_c: [attestation.slice(0, 32), "1", "1"],
    protocol,
    curve: "hybrid",
    attestation,
  };
}

export function complianceTierFromTrustTierProof(
  proof: TrustTierProof,
  audience: string,
  issuedAt: string,
): ZkClaimBundle {
  return {
    claimType: "compliance_tier",
    proof: {
      pi_a: proof.proof.pi_a,
      pi_b: proof.proof.pi_b,
      pi_c: proof.proof.pi_c,
      protocol: proof.proof.protocol,
      curve: proof.proof.curve,
      attestation: proof.proof.attestation,
    },
    publicSignals: proof.publicSignals,
    nullifier: proof.claim.nullifier,
    disclosed: {
      trustTier: Number(proof.publicSignals[3]),
      verified: proof.claim.satisfied,
    },
    issuedAt,
    audience,
    protocol: "groth16",
  };
}

export function proveComplianceTier(input: {
  tier: number;
  minTier: number;
  nullifier: string;
  audience: string;
  issuerSecret: string;
  issuedAt: string;
}): ZkClaimBundle {
  const tierProof = proveTrustTierGte({
    tier: input.tier,
    minTier: input.minTier,
    nullifier: input.nullifier,
    issuerSecret: input.issuerSecret,
  });
  return complianceTierFromTrustTierProof(tierProof, input.audience, input.issuedAt);
}

export function proveUniqueness(input: {
  nullifier: string;
  audience: string;
  issuerSecret: string;
  issuedAt: string;
}): ZkClaimBundle {
  const publicSignals = [
    BigInt(`0x${input.nullifier.slice(0, 16)}`).toString(),
    hashToBigIntString(`audience:${input.audience}`),
    "1",
  ];
  const attestation = signSignals(input.issuerSecret, publicSignals);
  return {
    claimType: "uniqueness",
    proof: groth16ShapeFromAttestation(attestation, UNIQUENESS_CIRCUIT),
    publicSignals,
    nullifier: input.nullifier,
    disclosed: { verified: true },
    issuedAt: input.issuedAt,
    audience: input.audience,
    protocol: "groth16",
  };
}

export function proveAuthorization(input: {
  clientId: string;
  scopes: string[];
  authorized: boolean;
  nullifier: string;
  audience: string;
  issuerSecret: string;
  issuedAt: string;
}): ZkClaimBundle {
  const scopeDigest = createHash("sha256")
    .update([...input.scopes].sort().join(" "))
    .digest("hex");
  const authorizedFlag = input.authorized ? "1" : "0";
  const publicSignals = [
    hashToBigIntString(`client:${input.clientId}`),
    authorizedFlag,
    hashToBigIntString(`scopes:${scopeDigest}`),
  ];
  const attestation = signSignals(input.issuerSecret, publicSignals);
  return {
    claimType: "authorization",
    proof: groth16ShapeFromAttestation(attestation, AUTHORIZATION_CIRCUIT),
    publicSignals,
    nullifier: input.nullifier,
    disclosed: { authorized: input.authorized },
    issuedAt: input.issuedAt,
    audience: input.audience,
    protocol: "groth16",
  };
}

export function provePaymentStepUp(input: {
  challengeId: string;
  paymentHash: string;
  nullifier: string;
  audience: string;
  authorized: boolean;
  issuerSecret: string;
  issuedAt: string;
}): ZkClaimBundle {
  const authorizedFlag = input.authorized ? "1" : "0";
  const publicSignals = [
    hashToBigIntString(`challenge:${input.challengeId}`),
    hashToBigIntString(`payment:${input.paymentHash}`),
    authorizedFlag,
    hashToBigIntString(`nullifier:${input.nullifier.slice(0, 32)}`),
  ];
  const attestation = signSignals(input.issuerSecret, publicSignals);
  return {
    claimType: "payment_step_up",
    proof: groth16ShapeFromAttestation(attestation, PAYMENT_STEP_UP_CIRCUIT),
    publicSignals,
    nullifier: input.nullifier,
    disclosed: { authorized: input.authorized },
    issuedAt: input.issuedAt,
    audience: input.audience,
    protocol: "groth16",
  };
}

function verifyPaymentStepUpClaim(
  claim: ZkClaimBundle,
  issuerSecret: string,
): ZkVerifyClaimResult {
  const [, , authorized] = claim.publicSignals;
  if (authorized !== "1") {
    return { valid: false, claimType: "payment_step_up", reason: "not_authorized" };
  }
  const result = verifyAttestationOnly(claim, issuerSecret);
  return { ...result, claimType: "payment_step_up" };
}

function verifyAttestationOnly(
  claim: ZkClaimBundle,
  issuerSecret: string,
): { valid: boolean; reason?: string } {
  const expected = signSignals(issuerSecret, claim.publicSignals);
  const got = claim.proof.attestation;
  if (!got || expected.length !== got.length) {
    return { valid: false, reason: "bad_attestation" };
  }
  const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  if (!ok) return { valid: false, reason: "attestation_mismatch" };
  return { valid: true };
}

function verifyUniquenessClaim(
  claim: ZkClaimBundle,
  issuerSecret: string,
): ZkVerifyClaimResult {
  const [, , bound] = claim.publicSignals;
  if (bound !== "1") {
    return { valid: false, claimType: "uniqueness", reason: "not_bound" };
  }
  const result = verifyAttestationOnly(claim, issuerSecret);
  return { ...result, claimType: "uniqueness" };
}

function verifyAuthorizationClaim(
  claim: ZkClaimBundle,
  issuerSecret: string,
): ZkVerifyClaimResult {
  const [, authorized] = claim.publicSignals;
  if (authorized !== "1") {
    return { valid: false, claimType: "authorization", reason: "not_authorized" };
  }
  const result = verifyAttestationOnly(claim, issuerSecret);
  return { ...result, claimType: "authorization" };
}

function verifyComplianceTierClaim(
  claim: ZkClaimBundle,
  issuerSecret: string,
): ZkVerifyClaimResult {
  const result = verifyTrustTierGte({
    proof: claim.proof,
    publicSignals: claim.publicSignals,
    issuerSecret,
  });
  return { ...result, claimType: "compliance_tier" };
}

const CLAIM_VERIFIERS: Record<
  string,
  (claim: ZkClaimBundle, issuerSecret: string) => ZkVerifyClaimResult
> = {
  compliance_tier: verifyComplianceTierClaim,
  trust_tier_gte: verifyComplianceTierClaim,
  uniqueness: verifyUniquenessClaim,
  authorization: verifyAuthorizationClaim,
  payment_step_up: verifyPaymentStepUpClaim,
};

export function verifyZkClaimBundle(
  claim: ZkClaimBundle,
  issuerSecret: string,
): ZkVerifyClaimResult {
  if (!claim.claimType || !claim.proof || !Array.isArray(claim.publicSignals)) {
    return { valid: false, reason: "malformed_claim" };
  }
  if (
    !Array.isArray(claim.proof.pi_a) ||
    !Array.isArray(claim.proof.pi_b) ||
    !Array.isArray(claim.proof.pi_c)
  ) {
    return { valid: false, claimType: claim.claimType, reason: "malformed_proof" };
  }
  const verifier = CLAIM_VERIFIERS[claim.claimType];
  if (!verifier) {
    return { valid: false, claimType: claim.claimType, reason: "unknown_claim_type" };
  }
  return verifier(claim, issuerSecret);
}

export function verifyZkClaimBundles(
  claims: ZkClaimBundle[],
  issuerSecret: string,
): ZkVerifyBatchResult {
  const results = claims.map((claim) => verifyZkClaimBundle(claim, issuerSecret));
  return {
    valid: results.every((r) => r.valid),
    results,
  };
}

export function proveClaimBundle(input: {
  claimType: ZkClaimType;
  tier: number;
  minTier: number;
  nullifier: string;
  audience: string;
  clientId: string;
  scopes: string[];
  authorized: boolean;
  issuerSecret: string;
  issuedAt: string;
}): ZkClaimBundle | null {
  switch (input.claimType) {
    case "compliance_tier":
    case "trust_tier_gte":
      return proveComplianceTier({
        tier: input.tier,
        minTier: input.minTier,
        nullifier: input.nullifier,
        audience: input.audience,
        issuerSecret: input.issuerSecret,
        issuedAt: input.issuedAt,
      });
    case "uniqueness":
      return proveUniqueness({
        nullifier: input.nullifier,
        audience: input.audience,
        issuerSecret: input.issuerSecret,
        issuedAt: input.issuedAt,
      });
    case "authorization":
      return proveAuthorization({
        clientId: input.clientId,
        scopes: input.scopes,
        authorized: input.authorized,
        nullifier: input.nullifier,
        audience: input.audience,
        issuerSecret: input.issuerSecret,
        issuedAt: input.issuedAt,
      });
    default:
      return null;
  }
}
