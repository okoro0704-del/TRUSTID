# TrustID Trust Center (V2)

TrustID is an **Identity & Trust Management Platform** for the ecosystem.

## Trust levels

| Tier | Stars | Meaning |
|------|-------|---------|
| 0 | ☆☆☆ | Account created |
| 1 | ★☆☆ | At least one trusted device / passkey |
| 2 | ★★☆ | Verified identity |
| 3 | ★★★ | High assurance (future) |

Filled **stars = trust tier**. Trust Center and LifeOS both show this same count via `trustLevel.stars` / ZK prove public signals (`identity.trust_level` / `identity.zk_claims`).

Tier 1 **does not** mean government ID verification.

LifeOS should prefer `POST /zk/prove` over raw userinfo attributes (see [ZK_IDENTITY.md](./ZK_IDENTITY.md)).

## Device enrollment

1. Signed-in user: `POST /devices/enrollment` → pairing code + join URL  
2. New device: `/enroll?code=XXXXXX`  
3. Existing device approves: `POST /devices/enrollment/:id/approve`  
4. New device claims + WebAuthn register via enrollment token  

Codes expire in 10 minutes; enrollment tokens in 5 minutes; single-use after completion.

## Future government verification

Attach via `IdentityVerificationProvider` + `identity_verifications` without redesigning device auth.
See `docs/DEVICE_CREDENTIALS.md`.
