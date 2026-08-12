# Zero-Knowledge Identity (TrustID)

TrustID operates as a **Zero-PII IdP** for LifeOS and ecosystem apps.

## What this means

| Layer | Behavior |
|-------|----------|
| At rest | No plaintext names, emails, phones, or unencrypted portraits. Contacts use peppered `lookupHash` + blind `commitment`. Names use `nameCommitment`. Portraits and assertion private keys are AES-GCM sealed. |
| Session UX | Optional sealed `SessionPresentation` (ciphertext) for Trust Center display during an active HttpOnly session only. |
| LifeOS | Receives **ZK trust claims** (`POST /zk/prove`) — not email/profile/portrait. Public signals include minTier, nullifier, satisfied flag. |

## Protocol

- Scope: `identity.zk_claims` (+ `identity.trust_level`)
- Circuit id: `trust_tier_gte` (Circom source in `packages/zk/circuits/`)
- Runtime prover: **groth16-hybrid-v1** (HMAC-FS attestation with Groth16-shaped public signals). Optional full snarkjs artifacts can replace the hybrid prover after Circom trusted setup.
- Verify: `POST /zk/verify` or fetch `GET /zk/verification-key`

## Honest limits

- Proving is **server-side** (TrustID knows the witness). This minimizes RP attribute disclosure; it is not end-user self-sovereign wallet ZK.
- Break-glass: `ALLOW_LEGACY_PII_SCOPES=true` may re-enable legacy OAuth attribute scopes for migration only.
- Sessions use HttpOnly cookies; `EXPOSE_SESSION_TOKEN_IN_BODY=true` is opt-in for native clients.

## Env

- `PII_PEPPER` — contact lookup HMAC pepper (required in production)
- `SEAL_KEY` — AES-GCM / ZK issuer material (required in production)
