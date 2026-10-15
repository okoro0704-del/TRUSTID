# Android Master Device enrollment and approval (T3)

Status: implemented on `feat/android-master-device` (based on production `fc32eca`). **Not enabled
in production** (`MASTER_DEVICE_ENROLLMENT` unset). Not deployed.

## Trust model

A TrustID session proves who is signed in. It never creates an approval authority. A Master Device
is enrolled only with all of:

1. a TrustID session (the subject),
2. a fresh passkey assertion **with user verification** (UV) on a trusted device of that subject,
3. proof of possession: the new key signs bytes TrustID issued for this enrollment,
4. a verified **Android Key Attestation** for that key, generated with TrustID's challenge.

Each approval is the enrolled key's ECDSA signature over a server payload that binds challenge,
subject, requesting client, action, operation digest, relying-party session and expiry. The key can
sign only after a fresh Class 3 biometric — a hardware-enforced key property the server verified in
the attestation.

## Architecture

| Piece | Where | What it does |
|---|---|---|
| Passkeys | `apps/device/native/android/PasskeyPlugin.kt` | Android Credential Manager (Option B). Assertion origin `android:apk-key-hash:<cert>`; accepted only for `WEBAUTHN_ANDROID_ORIGINS`. Android 9+. |
| Master Device key | `apps/device/native/android/MasterDevicePlugin.kt` | Keystore EC P-256, `PURPOSE_SIGN`, SHA-256, per-use `AUTH_BIOMETRIC_STRONG` (no PIN, no time window), invalidated by new biometric enrollment, StrongBox when present else TEE, attestation challenge from the server. Measures `KeyInfo` security level; software keystores are refused and the key deleted. Signs only TrustID's three payload formats and builds the biometric prompt from the payload (action, requesting app, TrustID), never from web-supplied text. |
| Ceremony | `apps/web/src/lib/masterDeviceNative.ts`, `components/StepUpRequests.tsx` | begin → keygen(challenge) → bind key → biometric signature over the server bytes (checked to name this subject and key first) → passkey (UV) for THIS enrollment → complete. The key is kept only after the server accepts it. Removal: revoke/begin → device signature over single-use, expiring bytes → passkey for THIS removal → revoke. |
| Attestation verifier | `apps/api/src/modules/step-up/android-key-attestation.ts` | Chain signatures, CA flags, validity, Google roots pinned by key (`android-attestation-roots.ts`), revocation list (every listed serial, REVOKED or SUSPENDED), leaf key = enrolled key, challenge, security level (TEE/StrongBox), key generated in the hardware (origin GENERATED, not imported), purpose SIGN, EC P-256, SHA-256, `noAuthRequired` absent, `userAuthType` = biometric only, no `authTimeout`, verified boot + locked bootloader, app package and signing certificate. All in the hardware-enforced list. |
| Enrollment API | `apps/api/src/modules/step-up/master-device-enrollment.ts`, `routes/step-up.ts` | `POST /v1/step-up/master-device/enrollment`, `/enrollment/key`, `/enrollment/reauth`, `/enrollment/complete`, `/revoke/begin`, `/revoke`; `GET /v1/step-up/master-device`, `/activity`. HMAC-sealed tokens bound to subject, session, key and enrollment state; each enrollment state can be completed once (concurrent completions cannot create two devices). |
| Passkey UV | `modules/authentication/webauthn.ts` | `verifyReauthentication({ requireUserVerification: true, binding })`: enrollment and removal passkeys answer challenges HMAC-bound to that operation (purpose `master_device_reauth`); generic re-authentication challenges are refused for them and vice versa. |

## Configuration (API)

| Variable | Production value | Meaning |
|---|---|---|
| `MASTER_DEVICE_ENROLLMENT` | unset (paused) | `enabled` turns the ceremony on. |
| `ANDROID_APP_SIGNING_SHA256` | release cert digest | Allowed app signing certificates (hex, comma list). Empty → enrollment refuses (503). |
| `ANDROID_APP_PACKAGE` | `com.trustid.device` | Allowed package(s). |
| `WEBAUTHN_ANDROID_ORIGINS` | `android:apk-key-hash:<b64url cert digest>` | Native passkey origins accepted for assertions. |
| `ANDROID_ATTESTATION_MIN_LEVEL` | `tee` | `strongbox` to require StrongBox. |
| `ANDROID_ATTESTATION_REQUIRE_VERIFIED_BOOT` | unset (true) | Require verified boot and a locked bootloader. |
| `ANDROID_ATTESTATION_MIN_VERSION` | unset (3) | Minimum attestation version; can only raise the built-in floor of 3 (Keymaster 4). |
| `ANDROID_ATTESTATION_CLOCK_SKEW_SECONDS` | unset (300) | Tolerance for certificate validity and key creation time (max 900). |
| `ANDROID_ATTESTATION_REVOCATION_CHECK` | unset (on) | Google status list; unreachable → enrollment fails closed (503). |
| `MASTER_DEVICE_RECOVERY_COOLDOWN_HOURS` | unset | Unset: a revoke without the device blocks re-enrollment until account recovery exists. |
| `MASTER_DEVICE_ATTESTATION` | unset | `off` only outside production (staging browser keys). |

## Device management

Owner sees: enrolled device, platform, security level, enrollment date, last use, recent activity
(enrollments, revocations, failed attempts, requests created/approved/declined/expired; no IPs,
keys or tokens). Revoke from the phone (device signature + passkey UV) allows immediate
re-enrollment. Revoke without the phone (passkey UV) blocks re-enrollment until the separate
recovery process exists — replacement of a lost device is **disabled** by design until then.

## Audit

`master_device.registered` (session reference hash, platform, security level, boot state),
`step_up.master_device_enrollment_failed` (reason), `step_up.master_device_revoked` (proof),
`step_up.approval_failed` (reason), `step_up.challenge_denied`, `step_up.challenge_expired`,
`master_auth.challenge_issued` (issuer = signed-in subject), `master_auth.approval_failed`.
Never logged: private keys, passkey material, biometric data, full tokens, session ids.

## Digital Asset Links

`apps/web/public/.well-known/assetlinks.json` associates `com.trustid.device` with the certificate
that signs the **currently distributed** APK (`8E:5E:B2:94:…:36:AA`, read from the published
`TrustID.apk` with apksigner). Served as JSON (Netlify headers; the SPA fallback is not forced).

**Release gate:** that certificate is the Android *debug* key from a developer machine. Before
enabling passkeys for production, sign the app with a protected release key (Play App Signing or
an offline keystore), update `assetlinks.json`, `ANDROID_APP_SIGNING_SHA256` and
`WEBAUTHN_ANDROID_ORIGINS` together, and plan the app re-install (a new signing key cannot update
an app signed with the old one).

## Release gates (all required before production)

1. Release signing key in place; Digital Asset Links updated and verified with Google's
   statement-list tester on the live domain.
2. Physical-device acceptance on Android 9+ phones with TEE and with StrongBox: passkey (UV) via
   Credential Manager, enrollment, approval, denial, expiry, revoke, process restart, offline.
3. Staging integration (staging kit) with the release-signed app.
4. Independent security review of this branch.
5. Owner approval; then `MASTER_DEVICE_ENROLLMENT=enabled` with the configuration above.

## Release-candidate documents

- `android-master-device-self-review.md` — implementer's adversarial review: fixed and open findings (not an independent audit).
- `android-master-device-release-signing.md` — release key custody, coordinated DAL / API configuration, debug → release migration.
- `android-master-device-device-acceptance.md` — physical-device test matrix (TEE and StrongBox phones).
- `android-master-device-staging.md` — isolated staging architecture, implemented routing / build isolation, isolation evidence.
- `android-master-device-review-checklist.md` — checklist for the independent security review.
