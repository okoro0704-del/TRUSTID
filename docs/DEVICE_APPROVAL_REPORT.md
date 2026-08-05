# TrustID V2.1 — Implementation Report

## Schema changes

| Change | Purpose |
|--------|---------|
| `Device.trustLevel` | `primary` \| `standard` \| `temporary` |
| `Device.expiresAt` | Temporary device end time |
| `Session.kind` | `standard` \| `temporary` |
| `DeviceApprovalRequest` | Cross-device approval domain model |
| `SecurityNotification` | Simulated primary-device alerts |

## New APIs

| Method | Path |
|--------|------|
| POST | `/device-approvals` |
| GET | `/device-approvals/poll/:token` |
| POST | `/device-approvals/claim` |
| POST | `/device-approvals/register/options\|verify` |
| GET | `/device-approvals`, `/device-approvals/pending` |
| POST | `/device-approvals/:id/approve\|temporary\|decline` |
| GET/DELETE | `/devices/temporary`, `/devices/temporary/:id` |
| POST | `/devices/:id/promote` |
| POST | `/auth/webauthn/reauth/options` |
| GET | `/notifications`, POST `/notifications/:id/read` |
| GET | `/recovery/status` (architecture placeholder) |

Device revoke now requires WebAuthn reauth + primary actor.

## UI screens

- `/waiting-approval` — waiting / claim / register
- `/dashboard/approvals` + Approve Device dialog
- `/dashboard/temporary`
- `/dashboard/notifications`
- Continue: “Request approval on trusted device”
- Devices: trust level, promote, reauth revoke

## Auth flow updates

Unknown device no longer forced through only local passkey. Approval path creates a pending request; LifeOS continues to wait on TrustID until session + consent complete (no LifeOS changes).

## Security

- Primary-only trust decisions
- WebAuthn UV for approve / temporary / decline / promote / revoke
- Temporary sessions do not register credentials
- Approval + enrollment tokens expire; claim is single-use
- Audit events for request / approve / temporary / decline / expire / promote / primary change

## Tests

See `npm test` — includes `device-approval.test.ts`.

## Future government recovery

Use `IdentityVerificationProvider` + `modules/recovery/types.ts` providers without changing device approval authority.
