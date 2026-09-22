# Digi Authority Layer (Phase T3)

Consequential capability model owned by Digi — not TrustID.

```text
TrustID  ?  WHO (identity / step-up)
Digi     ?  OWNERSHIP (T2)
Authority?  WHAT MAY BE AUTHORIZED (T3)
Service  ?  ACTION
```

## Package

`@trustid/digi-authority` — grants, policy, EdDSA tokens, consumption, audit.

Digi RP mounts machine + owner APIs under `/authority/*`.

## Token format

Separate from TrustID identity assertions.

| Claim | Meaning |
|-------|---------|
| `iss` | `digiconomy-authority` |
| `sub` | Digi `ownerId` |
| `aud` | Service audience (`tv`, `radio`, `elfcom`, …) |
| `actor` | `type:id` (e.g. `digital_twin:mrfundzman`) |
| `actions` / `resources` | Namespaced scopes |
| `limits` | Quantitative caps |
| `approval` | `ALLOW` \| `DENY` \| `ASK_OWNER` \| `ALLOW_WITH_LIMITS` |
| `grantId` / `grantVersion` | Persistent grant binding |
| `oneTime` / `jti` | Replay protection |
| `iat` / `nbf` / `exp` | Short-lived (default 300s) |

Alg: **EdDSA**. Public keys: `GET /.well-known/authority-jwks.json`.

Identity assertions must **not** be reused as authority tokens.

## Revocation model (chosen)

1. **Persistent grants** — `status=REVOKED` blocks all future `issueToken`.
2. **Already-issued short-lived tokens** — **short TTL only** (default 5 minutes). No global revocation list in T3.
3. **Optional hardening** — `grantVersion` mismatch rejects use if grant is re-versioned later.

Documented trade-off: revoked grants stop new issuance immediately; in-flight tokens remain valid until `exp`.

## Approval modes

First-class: `ALLOW`, `DENY`, `ASK_OWNER`, `ALLOW_WITH_LIMITS`.

## Reference policy

`DIGITAL_TWIN_MRFUNDZMAN_POLICY` — fixture for Digital Twin actor, not global law.

## SQL

`apps/digi-rp/migrations/002_authority.sql` + `SqliteAuthorityStore` (`node:sqlite`) for verified SQL path.

## Fail closed

Malformed / wrong aud / wrong actor / wrong resource / expired / revoked / limit / replay ? `DENY`.

## Canonical TrustID issuer recommendation (T3 review)

Current identity issuer (T2 frozen):

`https://trustedid.netlify.app/api`

| Concern | Notes |
|---------|--------|
| Transport | Netlify has hit `usage_exceeded`; Railway API remains healthy |
| Canonical issuer | **Keep** `https://trustedid.netlify.app/api` as the OIDC `iss` claim until Digi has an explicit dual-issuer allowlist |
| Transport endpoint | Prefer Railway origin for JWKS/API traffic; Netlify can remain a reverse proxy alias |
| Migration | If issuer must change: (1) Digi accept both old+new `iss` during window, (2) never mint dual owners for same `sub`, (3) merge/alias `external_identities` rows — **do not** silently change `iss` |

T3 does **not** change the TrustID issuer.
