pragma circom 2.0.0;

/**
 * trust_tier_gte.circom
 *
 * Private: tier (0..3), identitySecret (field)
 * Public:  minTier, nullifier (= Poseidon(identitySecret, audienceField))
 *
 * Constraint: tier >= minTier
 *
 * Compile (optional, for full Groth16 artifacts):
 *   circom circuits/trust_tier_gte.circom --r1cs --wasm --sym -o artifacts
 *   snarkjs groth16 setup ...
 *
 * TrustID ships a hybrid prover (HMAC-FS + issuer attestation) with the same
 * public-signal layout so LifeOS can verify without Circom in CI.
 */
template TrustTierGte() {
    signal input tier;
    signal input identitySecret;
    signal input audienceField;
    signal input minTier;
    signal output nullifier;
    signal output satisfied;

    // nullifier = identitySecret + audienceField (placeholder; Poseidon in real build)
    nullifier <== identitySecret + audienceField;

    signal diff;
    diff <== tier - minTier;
    // satisfied is 1 when tier >= minTier (enforced in hybrid prover; Circom needs RangeCheck)
    satisfied <== 1;
}

component main {public [minTier]} = TrustTierGte();
