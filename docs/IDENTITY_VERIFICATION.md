# Identity Verification

## Purpose

Verify that the person controlling a TrustID account corresponds to the claimed identity — without hard-coding a single vendor.

## Provider abstraction

`IdentityVerificationProvider`:

- `beginVerification`
- `completeVerification`

Possible future implementations:

- government ID verification
- document verification
- selfie/liveness via a **trusted vendor** (templates stay with vendor/TrustID — never returned to apps)
- manual review
- other approved mechanisms

## Ceremony status

`pending` | `verified` | `failed` | `expired` | `revoked` | `not_verified`

## Development mock

`MockIdentityVerificationProvider` (`IDENTITY_VERIFICATION_MODE=mock` or default in development):

- Completes only when `providerPayload.mockApprove === true`
- Sets `isMock: true` and `verificationLevel: mock`
- **Must never be described as real identity verification**

Production must set `IDENTITY_VERIFICATION_MODE=noop` (or a real provider) and disable mock approval.

## APIs

- `POST /identity/verification/start` — `{ portraitId, method? }`
- `POST /identity/verification/complete` — `{ verificationId, providerPayload? }`

Device passkeys remain independent of this ceremony.
