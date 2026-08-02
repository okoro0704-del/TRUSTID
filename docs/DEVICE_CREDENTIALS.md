# TrustID — Trusted Device Credentials

## What a passkey proves

A successful WebAuthn ceremony proves the user controls a **trusted device credential** protected by the platform’s user-verification mechanism (biometric, PIN, or passcode — chosen by the OS).

It does **not** prove legal identity, BVN ownership, or government ID verification.

## WebAuthn configuration (V1 secure device flow)

| Setting | Value |
|---------|-------|
| `authenticatorAttachment` | `platform` |
| `userVerification` | `required` |
| `residentKey` | `preferred` |
| `attestation` | `none` |
| RP ID / Origin | from env (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`) |

TrustID stores: credential ID, COSE public key, counter, transports, AAGUID, attachment metadata.

TrustID never stores: private keys, fingerprints, face data, biometric templates, device PIN/passcode.

## Challenge purposes

| Purpose | Use |
|---------|-----|
| `registration` | First device passkey during onboarding |
| `device_addition` | Additional trusted credential while signed in |
| `authentication` | Sign-in |
| `reauthentication` | Reserved for step-up (same verify path) |

Challenges are generated with `crypto.randomBytes`, expire in 5 minutes, and are single-use (`consumedAt`).

## Signature counter behavior

See `apps/api/src/modules/authentication/counter.ts`.

- Counter increases → accept silently.
- Both zero → accept (common for platform authenticators).
- Unchanged or rollback → **accept** + `device.signature_counter.warning` audit.
- **No automatic account lockout** solely from counter anomalies.

## Account status vs credential status vs identity verification

| Layer | Meaning |
|-------|---------|
| Account status | `pending_verification` / `active` / … |
| Device / credential status | `active` / `revoked` |
| Identity verification | Separate future layer (`not_verified` until a provider succeeds) |

## Recovery limitation (current)

Contact OTP verifies channel ownership during enrollment. There is **no** weak “email magic link bypasses device trust” recovery path.

High-assurance recovery must be designed separately later and must not collapse into contact OTP alone.

## Future NIBSS / BVN attachment points

1. Implement `IdentityVerificationProvider` (see `apps/api/src/modules/identity-verification/`).
2. Register via `setIdentityVerificationProvider(...)`.
3. Persist results in `identity_verifications` (provider, method, status, hashes/references — **never biometrics**).
4. Surface status on `GET /identity` / dashboard (`identityVerification`).
5. Keep device authentication independent — BVN must not replace WebAuthn.

Do not call NIBSS until a real provider is configured.
