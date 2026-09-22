# Phase T4 — Real Capability Enforcement

## Resource grammar (ElfCom)

| Form | Meaning |
|------|---------|
| `elfcom:conversation:<conversationId>` | Send into an existing conversation/thread |
| `elfcom:recipient:<TrustID-sub>` | Address a recipient when no conversation yet |

Exact match only — no `elfcom:*`, no prefix matching.

## Actor binding

Possession of a Digi authority Bearer token whose `actor` claim equals the requested actor.

Do **not** trust `X-Actor` alone. The body `actor` must equal the verified token `actor`.

Tokens are short-lived (default 300s). Higher assurance (DPoP / mTLS) deferred.

## Authorship

| Field | Source |
|-------|--------|
| External sender | `ownerTrustId` (TrustID subject) when present, else Digi `sub` |
| `performedBy` | Token `actor` (e.g. `digital_twin:mrfundzman`) |

Audit retains both Digi `owner` (`sub`) and `actor`.

## Replay / consumption (Option A)

1. ElfCom verifies JWT locally (Digi authority JWKS).
2. For one-time tokens and limited grants, ElfCom calls Digi `POST /v1/authority/consume`.
3. Digi Postgres `authority_consumptions.jti` UNIQUE enforces one winner across instances.

Offline JWT verification alone cannot guarantee global one-time use — Digi shared state is required.

## Revocation

Grant revoke blocks **new** issuance. Already-issued tokens: short TTL only (documented T3/T4 limitation). Optional `grantVersion` check on consume.

## Canonical issuer

`iss = digiconomy-authority` remains the **logical** issuer identifier (not a URL). Documented before multi-primitive adoption. Not changed silently.

TrustID issuer `https://trustedid.netlify.app/api` frozen (T4 is not an issuer migration).

## Human vs delegated

| Path | Auth |
|------|------|
| Human messaging | TrustID / LifeOS capability JWT ? existing `/v1/threads/.../messages` |
| Delegated Twin/app | Digi authority Bearer ? `/v1/authority/messages/send` |

Human chat does **not** depend on Digi availability.

## Key separation

TrustID EdDSA keys ? identity assertions (`aud=digiconomy:digi`).  
Digi authority EdDSA keys ? capability assertions (`iss=digiconomy-authority`).  
Issuer/audience/claim shape make substitution fail closed.

## Second consumer

TV/Radio backends are **not** independent deployable APIs in this monorepo.

`SECOND CONSUMER NOT AVAILABLE`
