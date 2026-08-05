# TrustID V2 — Trust Center Final Report

## Summary

TrustID is now an Identity & Trust Management platform: users manage trusted devices, connected apps, sessions, passkeys, security history, trust level, and account preferences while existing WebAuthn + OAuth flows remain intact.

## Schema changes

| Change | Purpose |
|--------|---------|
| `Credential.displayName` | Friendly passkey names |
| `Application.logoUrl` | Connected-app branding |
| `DevicePairingRequest.pairingCode` | Short enrollment codes |
| `DevicePairingRequest.enrollmentTokenHash` / `enrollmentTokenExpires` | One-time post-approval enroll tokens |
| `AccountPreferences` | Theme, notifications, privacy, language |

Provider remains **SQLite** for local + Netlify function storage.

## New / extended API endpoints

| Method | Path | Notes |
|--------|------|------|
| GET | `/trust/summary` | Dashboard summary |
| GET | `/trust/level` | Trust tier |
| GET/PATCH/DELETE | `/passkeys`, `/passkeys/:id` | List / rename / remove |
| GET/PATCH | `/account/preferences` | Account settings |
| GET | `/account/identity-verification` | Placeholder verification status |
| GET | `/security/events` | Filter by `type`, `from`, `to` |
| GET | `/security/login-history` | Read-only auth history |
| GET/DELETE | `/sessions`, `/sessions/:id` | Active sessions |
| POST | `/sessions/revoke-all` | End other sessions |
| POST | `/devices/enrollment` | Create invite + code + join URL |
| GET | `/devices/enrollment/:code` | Poll status |
| POST | `/devices/enrollment/:id/approve` | Approve from trusted session |
| POST | `/devices/enrollment/:code/claim` | Claim enroll token on new device |
| POST | `/devices/enrollment/register/options\|verify` | WebAuthn on new device |

Existing device, authorization, and OAuth routes unchanged in contract.

## UI sections

Under `/dashboard` (Trust Center shell):

- Overview — identity, trust tier, counts, recommendations, recent events  
- Devices — list, rename, revoke, details, enrollment code flow  
- Applications — connected apps, permission viewer, disconnect  
- Sessions — end one / end others  
- Passkeys — rename / remove (last passkey blocked)  
- Security — verification placeholder, login history, event filter, recovery placeholder  
- Account — profile + preferences  
- `/enroll` — new-device pairing + passkey registration  

## Security improvements

- Enrollment codes expire (~10m); enroll tokens (~5m); completed enrollments clear tokens  
- Device revoke invalidates credentials + device sessions + audit  
- App disconnect revokes OAuth access/refresh tokens  
- Passkey remove cannot leave zero auth methods  
- Trust tiers do not claim government verification at Tier 0/1  
- Audit events for enrollment, rename/revoke device, passkeys, apps, sessions, settings  

## Automated tests

Run: `npm test` (API workspace).

Coverage added in `apps/api/tests/trust-center.test.ts`:

- Trust tier 0 → 1 with trusted device  
- Enrollment invite → approve → claim  
- Passkey rename + last-passkey guard  
- Trust summary counts  
- Application authorization revoke  
- Session terminate  

Plus existing WebAuthn / challenge / counter tests.

## Architecture notes — future government verification

1. Keep `IdentityVerificationProvider` as the only integration surface.  
2. Persist outcomes in `identity_verifications` only (no biometrics).  
3. Map verified status → Trust Tier 2; reserve Tier 3 for high-assurance policy.  
4. Expose verification status via scopes (`identity.verification_status`) without changing device auth.  
5. Do not couple enrollment/WebAuthn to government ID flows.  
