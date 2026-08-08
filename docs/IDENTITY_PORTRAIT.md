# Identity Portrait

## Core rule

A user-uploaded photograph is **not** a verified identity portrait.

Only after TrustID verification succeeds may TrustID issue a:

**VERIFIED_IDENTITY_PORTRAIT**

## Portrait states

| Status | Meaning |
|--------|---------|
| `none` | No portrait |
| `user_uploaded` | Photo stored privately — **not** verified |
| `pending_verification` | In a verification ceremony |
| `verified` | Authoritative verified identity portrait |
| `rejected` | Failed verification |
| `revoked` | No longer authoritative |

Only `verified` may be presented to applications as a verified portrait.

## Versioning

Each verified issuance increments `portraitVersion` and `profileVersion`.

When a new portrait is verified:

1. Previous verified portraits are **revoked**
2. Profile points at the new portrait ref
3. New signed assertions carry the new versions
4. Apps must not permanently cache old portraits as authoritative

## APIs

- `POST /identity/portrait` — upload (session)
- `GET /identity/portrait` — owner view, or app view with `identity.portrait` scope (verified only)
- `POST /identity/portrait/revoke` — revoke verified portrait
- `GET /identity/media/:id?token=` — access-controlled bytes (HMAC token, short TTL)

## LifeOS / HospitalityOS

Apps may display TrustID’s verified portrait where authorized.

They must **not** let a normal profile editor overwrite the authoritative verified portrait.

Business logos, hotel images, menus, and org avatars are **not** identity portraits.
