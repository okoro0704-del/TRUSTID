# Digiconomy Trust Bridge (Phase T2)

## Trust boundary

- **TrustID** owns human identity (`User.trustId` as subject).
- **Digi** owns Digi application owners and Digi sessions.
- Digi never queries the TrustID database, never receives embeddings/passkeys/WebAuthn material, and never uses email/phone/username as identity keys.

Canonical link:

`TrustID issuer + TrustID subject (sub) ? Digi owner`

## Assertion contract

Issued by TrustID:

`POST /trust/assertions/digi` (requires TrustID session cookie/header)

Claims (minimal):

| Claim | Value |
|-------|--------|
| `iss` | `https://trustedid.netlify.app/api` (or `config.oidcIssuer`) |
| `sub` | authenticated `User.trustId` (server-derived; never client-chosen) |
| `aud` | `digiconomy:digi` (prod) / `digiconomy:digi:dev` (non-prod) / `DIGI_AUDIENCE` |
| `iat` / `nbf` / `exp` | short-lived (~60s) |
| `jti` | unique UUID |
| header `alg` | `EdDSA` only |
| header `kid` | TrustID JWKS key id |

## Verification (Digi)

Package: `@trustid/digi-bridge`

1. Fetch/cache JWKS from TrustID `/.well-known/jwks.json`
2. Allowlist `alg=EdDSA` (reject `none` / unknown)
3. Resolve `kid` (refresh JWKS once on unknown)
4. Verify signature + `iss` + `aud` + temporal claims + `sub` + `jti`
5. Atomically consume `jti` (Digi-side)
6. Resolve/create Digi owner on unique `(issuer, subject)`
7. Create Digi session (independent of TrustID session)

Exchange: `POST /auth/trustid/exchange` on Digi RP (`apps/digi-rp`)

## Owner resolution

- Unique constraint / atomic upsert on `(issuer, subject)`
- Concurrent first login cannot create two owners
- No silent migration of an external identity to another owner
- No email/phone merge

## Security invariants

Digi must never receive from TrustID:

- biometric embeddings / templates / raw face data
- passkey / WebAuthn credential material
- passwords, OTPs, recovery secrets
- TrustID session cookies as Digi sessions

T1 honesty preserved: PAD=`INCOMPLETE`, threshold=`UNCALIBRATED`.
