# TrustID V1 — Security Assumptions

## Trust boundaries

1. **TrustID API** is the sole authority for consumer identity credentials and TrustID sessions.
2. **Relying parties** (LifeOS, etc.) are untrusted with master credentials; they receive scoped tokens only.
3. **Browsers / authenticators** hold private passkey material; TrustID stores only public keys and counters.
4. **Transport:** production must use HTTPS; cookies `Secure`, `HttpOnly`, `SameSite`.

## Secret handling

| Secret | Storage |
|--------|---------|
| OTP codes | Salted hash, short TTL, attempt limits |
| Session tokens | Hash only (random 32+ bytes) |
| OAuth codes / tokens | Hash only |
| Client secrets | Hash only |
| WebAuthn private keys | Never stored server-side |
| User passwords | Not used |

## Session policy (V1 defaults)

- Absolute lifetime: 7 days (sliding last_seen optional)
- Idle consideration: revoke on logout / global revoke / device revoke
- Bound to device when created via WebAuthn on that device

## WebAuthn / trusted device credentials

- RP ID and allowed origins configured via env
- Platform authenticator preferred (`authenticatorAttachment: platform`)
- User verification **required** for registration and authentication
- Challenges: CSPRNG, 5-minute TTL, single-use, purpose-bound
- Signature counter: increments accepted; zero/zero accepted; anomalies audited (`device.signature_counter.warning`) without automatic lockout — see `docs/DEVICE_CREDENTIALS.md`
- Device revoke marks device + credentials revoked; assertions rejected
- Never store private keys or biometric material

## Identity verification (future)

- Separate from device credentials via `IdentityVerificationProvider`
- `identity_verifications` table prepared; no NIBSS/BVN calls in V1
- Default status exposed to clients: `not_verified`

## OAuth

- Authorization Code + PKCE required for public clients
- Redirect URI exact match against registered list
- Scopes intersect requested ∩ allowed ∩ user-consented
- Access token TTL: 1 hour; refresh optional via `offline_access`

## Verification assurance

OTP proves control of a contact channel at a point in time. It does **not** prove legal identity. Higher assurance must be a separate, additive verification layer.

## Audit

Security-relevant actions emit `audit_events` retained server-side independently of user-visible activity feed.

## Operational assumptions

- Dev OTP may be logged/returned; production must use SMS/email providers and never return codes.
- SQLite is for local V1; production should use PostgreSQL, backups, and encryption at rest.
- Rate limiting is implemented in-process for V1; production needs distributed limits / WAF.
