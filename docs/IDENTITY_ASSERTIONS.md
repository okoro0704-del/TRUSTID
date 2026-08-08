# Identity Assertions

## Protocol

TrustID issues **signed JWTs** (EdDSA) as identity assertions for LifeOS, HospitalityOS, Digiconomy, and Token Network.

This extends the existing TrustID authorization model — it does **not** replace OAuth sessions or invent a second login protocol.

## Claims (non-exhaustive)

- `trustId`, `displayName`
- `identityStatus`, `verificationLevel`
- `portraitRef`, `portraitVersion` (only when verified)
- `profileVersion`
- `aud` (audience-bound), `iss`, `iat`, `exp`, `jti`
- `scope`

**Never** included: biometrics, embeddings, templates, liveness signals, raw documents, passwords.

## Endpoints

- `POST /identity/assertions` — issue (authenticated)
- `POST /identity/assertions/verify` — verify signature, audience, expiry, profile version; optional `consume` for replay protection
- `GET /.well-known/jwks.json` — public keys

## Protections

| Control | Mechanism |
|---------|-------------|
| Signature | EdDSA via JWKS |
| Audience binding | `aud` must match |
| Time bound | `exp` |
| Replay | `jti` tracked; optional single-use consume |
| Stale profile | `profileVersion` must match current |
| Revocation | revoked identity rejected on verify |

## Token Network

Associate wallets with TrustID assertions off-chain. Do **not** put real name, portrait, or biometrics on-chain.
