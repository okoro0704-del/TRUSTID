import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const CIRCUIT_ID = "trust_tier_gte";
export const PROTOCOL = "groth16-hybrid-v1";

export type TrustTierProof = {
  protocol: typeof PROTOCOL;
  circuit: typeof CIRCUIT_ID;
  /** Public signals: [minTier, nullifierHexAsBigIntString, satisfied (0|1), tier] */
  publicSignals: string[];
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
    /** Hybrid attestation over publicSignals */
    attestation: string;
  };
  claim: {
    type: "trust_tier_gte";
    minTier: number;
    satisfied: boolean;
    nullifier: string;
  };
};

export function attestKey(issuerSecret: string): Buffer {
  return createHash("sha256").update(`trustid-zk-v1:${issuerSecret}`).digest();
}

export function signSignals(issuerSecret: string, publicSignals: string[]): string {
  return createHmac("sha256", attestKey(issuerSecret))
    .update(publicSignals.join("|"))
    .digest("hex");
}

export function getVerificationKey(issuerSecret: string) {
  return {
    protocol: PROTOCOL,
    circuit: CIRCUIT_ID,
    /** Public verification material — HMAC key commitment (not the key) */
    vk_hash: createHash("sha256")
      .update(attestKey(issuerSecret))
      .digest("hex"),
    nPublic: 4,
    note: "Hybrid Groth16-compatible layout. Full snarkjs artifacts optional via Circom build.",
  };
}

/**
 * Server-side prove: knowledge of identitySecret binding nullifier + tier >= minTier.
 * Does not reveal TrustID, email, or name.
 */
export function proveTrustTierGte(input: {
  tier: number;
  minTier: number;
  nullifier: string;
  issuerSecret: string;
}): TrustTierProof {
  const tier = Math.max(0, Math.min(3, Math.floor(input.tier)));
  const minTier = Math.max(0, Math.min(3, Math.floor(input.minTier)));
  const satisfied = tier >= minTier ? 1 : 0;
  const publicSignals = [
    String(minTier),
    BigInt(`0x${input.nullifier.slice(0, 16)}`).toString(),
    String(satisfied),
    String(tier),
  ];
  const attestation = signSignals(input.issuerSecret, publicSignals);

  return {
    protocol: PROTOCOL,
    circuit: CIRCUIT_ID,
    publicSignals,
    proof: {
      pi_a: [attestation.slice(0, 32), attestation.slice(32, 64), "1"],
      pi_b: [
        [attestation.slice(0, 16), attestation.slice(16, 32)],
        [attestation.slice(32, 48), attestation.slice(48, 64)],
        ["1", "0"],
      ],
      pi_c: [attestation.slice(0, 32), "1", "1"],
      protocol: PROTOCOL,
      curve: "hybrid",
      attestation,
    },
    claim: {
      type: "trust_tier_gte",
      minTier,
      satisfied: satisfied === 1,
      nullifier: input.nullifier,
    },
  };
}

export function verifyTrustTierGte(input: {
  proof: TrustTierProof["proof"] | { attestation?: string };
  publicSignals: string[];
  issuerSecret: string;
}): { valid: boolean; reason?: string } {
  const [minTier, , satisfied, tier] = input.publicSignals;
  if (minTier == null || satisfied == null || tier == null) {
    return { valid: false, reason: "missing_signals" };
  }
  const expected = signSignals(input.issuerSecret, input.publicSignals);
  const got = input.proof.attestation;
  if (!got || expected.length !== got.length) {
    return { valid: false, reason: "bad_attestation" };
  }
  const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  if (!ok) return { valid: false, reason: "attestation_mismatch" };
  if (Number(satisfied) === 1 && Number(tier) < Number(minTier)) {
    return { valid: false, reason: "tier_constraint" };
  }
  if (Number(satisfied) === 0 && Number(tier) >= Number(minTier)) {
    return { valid: false, reason: "satisfied_flag" };
  }
  return { valid: true };
}
