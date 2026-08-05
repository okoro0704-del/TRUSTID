# TrustID V2.1 — Device Approval & Cross-Device Auth

## Flow

1. Unknown device: Continue → **Request approval on trusted device**
2. TrustID creates `DeviceApprovalRequest` + in-app notification for primary devices
3. Primary device: Approvals → Review → Trust / Temporary / Decline (WebAuthn UV)
4. Requesting device: Waiting screen polls → claim → passkey (trust) or session (temporary)
5. OAuth returnTo resumes → consent → LifeOS (no LifeOS code changes)

## Trust levels

| Level | Capabilities |
|-------|----------------|
| Primary | Approve devices, revoke others, promote, recovery changes (future) |
| Standard | Sign in with passkey |
| Temporary | Short session, no passkey, listed under Temporary Devices |

Every account keeps ≥1 Primary device.

## Config

- `DEVICE_APPROVAL_TTL_MINUTES` (default 10)
- `TEMPORARY_SESSION_HOURS` (default 8)

## Recovery

Extension points only — see `modules/recovery/types.ts`. Not implemented.
