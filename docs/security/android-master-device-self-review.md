# T3 Android Master Device — release-candidate self-review

**This is the implementer's own adversarial review, not an independent security audit.** It is
input for the independent review the release gates require (`android-master-device.md`).

Scope: `feat/android-master-device` (PR #3) on top of the production containment `fc32eca`.
Containment preserved: `apps/api/src/routes/trust-id.ts` is unchanged; the legacy register still
refuses signing keys; legacy approvals still verify a P-256 signature (only audit calls were added).

## Fixed on this branch (each with a regression test that fails on the previous code)

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | Medium | The attestation verifier did not check `KM_TAG_ORIGIN`. A key **imported** into the TEE/StrongBox (its private key existed outside the hardware) passed every other check, contradicting "generated in, and never leaves, secure hardware". | `android-key-attestation.ts:295` requires a hardware-enforced origin of `GENERATED`. Tests: "key imported…", "key origin not attested…". |
| F2 | Medium | Concurrent `enrollment/complete` calls (same token, or two ceremonies begun from the same state) each passed the checks and each created an active Master Device (reproduced: 3 of 3 succeeded). A later revoke removed only the newest; the others silently became the active approver. | `master-device-enrollment.ts:342` claims the enrollment state with a unique row before writing (released if the write fails). Test: "concurrent completions enroll at most one Master Device". |
| F3 | Medium (pre-existing) | `consumeWebAuthnChallenge` read then updated without a condition: concurrent requests could all consume one challenge (5 of 5 succeeded), so one passkey assertion could authorize several requests. Affects sign-in and re-authentication too. | `authentication/challenges.ts:62` consumes with `updateMany … consumedAt: null`; only one request wins. Test: "a WebAuthn challenge is consumed once…". |
| F4 | Medium | Native `sign()` signed **any** payload and showed a title/subtitle supplied by the web page. The app loads the live site in its WebView, so any script running there (XSS, compromised deploy) could obtain a biometric-gated signature under a misleading prompt. | `MasterDevicePlugin.kt:193` signs only the three TrustID formats (fixed field order, strict charset) and builds the prompt from the payload (action, requesting client, TrustID). Kotlin tests: `MasterDevicePromptTest`; API test checks every server payload fits that grammar. |
| F5 | Low | Revoking a device cancelled only *pending* challenges; an approval already signed but not yet consumed by the app remained consumable after the owner revoked a stolen phone. | `master-device-enrollment.ts:518` also cancels approved, unconsumed challenges. Test: "an approval no app has consumed yet dies with the revoked device". |
| F6 | Low | The Google attestation status list was filtered to `REVOKED`; `SUSPENDED` serials were trusted. A malformed list was treated as empty. | `revokedSerialsFromStatusList` (`android-key-attestation.ts:355`) distrusts every listed serial and fails closed on a malformed list. |

## Open findings (not fixed here; owner or reviewer decision)

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| O1 | **High** (pre-existing, release gate) | The distributed APK is a **debug build** signed with a developer machine's debug key (`apps/device/package.json:20` `assembleDebug`, `release.json:5` `development-debug`). Debug builds are `android:debuggable`: anyone with USB debugging access can `run-as com.trustid.device` (read app data, session cookies, WebView storage) and attach DevTools to the WebView (run script in the signed-in session). Anyone holding that debug keystore can sign an update the installed app accepts. Keystore private keys stay non-exportable. | Ship release-signed, non-debuggable builds only (`android-master-device-release-signing.md`). Enrollment stays paused until then. |
| O2 | Medium (pre-existing) | `android:allowBackup="true"` (`AndroidManifest.xml:28`): cloud backup / device transfer can copy app data, including WebView cookies and storage, to another device. | `allowBackup="false"` or `dataExtractionRules` that exclude `app_webview`, shared preferences and the media vault. Product decision (users lose backup). |
| O3 | Low | Re-authentication challenges are bound to the user and purpose `reauthentication`, not to the operation: an unused UV assertion obtained for one Trust Center action can be spent on another (enrollment, revoke, device approval) within its lifetime. Requires script in the TrustID origin and a user gesture. | Bind the reauth challenge to an operation (e.g. store `operation` with the challenge and check it on consume). |
| O4 | Low | The device revoke signature covers a static payload (`trustid-master-device-revoke/v1`, sub, device; `master-device-enrollment.ts:173`) with no server nonce or expiry. Replay is limited (the row's key changes on re-enrollment; revoke also needs a UV passkey) but it is not fresh. | Issue a nonce (e.g. from `GET /master-device`) and include `nonce`/`exp` in the payload; update `MasterDevicePrompt` accordingly. |
| O5 | Low | No minimum `attestationVersion`. The ceremony already requires per-use biometric keys, so old Keymaster versions fail elsewhere, but the policy should state it. | Require attestation version ≥ 3 (Keymaster 4, Android 9). |
| O6 | Low (availability) | Certificate validity is checked with the server clock (`android-key-attestation.ts:261`). A leaf whose `notBefore` is the phone's clock may be "not yet valid" if the phone runs ahead. | Watch for `certificate_validity_0` during device acceptance; allow a small skew for the leaf only if it occurs. |
| O7 | Info | Netlify deploy previews proxy `/api/*` to the **production** API (`netlify.toml:112`, forced redirect, all contexts). Verified read-only: production rejects the preview origin (`403 origin_not_allowed`) and has no T3 routes (`404`). Previews still run unreviewed code next to production. | Point previews/branch deploys at a staging API (see `android-master-device-staging.md`). |
| O8 | Info | `sendError` maps every 4xx error with a `statusCode` to `reauthentication_failed` (`routes/step-up.ts:49`). | Map only re-authentication errors; cosmetic. |
| O9 | Info | `WEBAUTHN_ANDROID_ORIGINS` admits native assertions for sign-in as well as re-authentication. Intended, but a debug-key app would be accepted if the debug certificate stayed configured. | Configure only the release certificate's hash (release gate). |

## Reviewed without findings

- Chain: per-certificate signature, validity and CA flag above the leaf; root pinned by SPKI
  (Google RSA and EC roots); leaf key equals the enrolled key; challenge equals
  `sha256("trustid-master-device-attest/v1:" + nonce)`.
- Hardware-enforced list required for purpose SIGN, EC, P-256, SHA-256, user auth, biometric-only
  auth type, no time window, root of trust; both security levels ≥ TEE (or StrongBox by policy);
  verified boot + locked bootloader; exactly one package and every signer digest allowed.
- Enrollment tokens: HMAC-sealed, bound to subject, TrustID session, key hash, enrollment state and
  expiry (whole seconds); proof of possession over server bytes; UV enforced from the authenticator
  data flag, not from options.
- Approvals: signature over challenge, subject, client, action, operation digest, RP session hash,
  device and expiry; single winner under concurrency; consumption bound to client, session and
  operation; revoked devices cannot approve.
- Audit: failures with reasons, denials, expiries, revocations; session referenced by hash; no keys,
  signatures, tokens, IPs or biometric data in the activity view.
- Emulator override: needs `BuildConfig.DEBUG` **and** an emulator **and** an explicit flag; false
  in release builds; the API rejects software attestations regardless.
