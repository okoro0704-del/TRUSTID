# Minimal Identity Attestations (TrustID)

TrustID operates as a **Zero-PII IdP** for LifeOS and ecosystem apps.

## What this means

| Layer | Behavior |
|-------|----------|
| At rest | No plaintext names, emails, phones, or unencrypted portraits. Contacts use peppered `lookupHash` + blind `commitment`. Names use `nameCommitment`. Portraits and assertion private keys are AES-GCM sealed. |
| Session UX | Optional sealed `SessionPresentation` (ciphertext) for Trust Center display during an active HttpOnly session only. |
| LifeOS | Receives minimal issuer attestations (`POST /zk/prove`) rather than email/profile/portrait. Public signals include minTier, nullifier, satisfied flag. These are not zero-knowledge proofs in the current implementation. |

## Protocol

- Scope: `identity.zk_claims` (+ `identity.trust_level`)
- Circuit id: `trust_tier_gte` (Circom source in `packages/zk/circuits/`)
- Runtime attester: **HMAC-SHA-256 issuer attestation** with a legacy Groth16-shaped wire layout. It is neither Groth16 nor zero knowledge; the actual tier is public. A future genuine SNARK implementation would require separate proving, verification, setup, and security review work.
- Verify: `POST /zk/verify` or fetch `GET /zk/verification-key`

## Honest limits

- Proving is **server-side** (TrustID knows the witness). This minimizes RP attribute disclosure; it is not end-user self-sovereign wallet ZK.
- Break-glass: `ALLOW_LEGACY_PII_SCOPES=true` may re-enable legacy OAuth attribute scopes for migration only.
- Sessions use HttpOnly cookies; `EXPOSE_SESSION_TOKEN_IN_BODY=true` is opt-in for native clients.

## Env

- `PII_PEPPER`  contact lookup HMAC pepper (required in production)
- `SEAL_KEY`  AES-GCM / ZK issuer material (required in production)
