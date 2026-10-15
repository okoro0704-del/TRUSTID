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

## Second round (staging foundation): former open findings now fixed

| # | Was | Fix | Tests |
|---|---|---|---|
| O2 | Medium: `allowBackup="true"`; app data (WebView cookies/storage, prefs, vault) could leave the device by cloud backup or device transfer | `allowBackup="false"`, `fullBackupContent="false"` and `dataExtractionRules` excluding every domain for cloud backup **and** device-to-device transfer (Android 12+ ignores `allowBackup` for transfer). | `scripts/tests/android-backup-policy.test.mjs`; `verify-android-apk.mjs` checks the built APK; lint-vital validates the rules file |
| O3 | Low: re-authentication not bound to the operation | Master Device enrollment and removal use their own passkey options: the challenge is `nonce ‖ HMAC(seal key, operation, subject, session, enrollment/removal nonce, key/device)`, stored under purpose `master_device_reauth`. The server checks the binding before consuming. Generic Trust Center challenges are refused for these operations, and bound challenges are refused everywhere else. | "a generic Trust Center re-authentication cannot enroll or remove…", "a passkey made for one enrollment or removal is refused for another…" |
| O4 | Low: static device-removal signature | `POST /v1/step-up/master-device/revoke/begin` issues a single-use removal: a sealed token, `trustid-master-device-revoke/v2` bytes with `nonce` and `exp` (5 min), and bound passkey options. Removal claims the nonce once. v1 static signatures are refused by the server **and** by the native signer. | "device removal signatures are single-use and expire; the old static payload is refused"; `MasterDevicePromptTest` |
| O5 | Low: no minimum attestation version | Built-in floor `attestationVersion ≥ 3` (Keymaster 4); `ANDROID_ATTESTATION_MIN_VERSION` can only raise it. | "attestation version older than Keymaster 4" |
| O6 | Low: attestation clocks | Certificate validity with a bounded skew (default 300 s, max 900 s). The key's `creationDateTime` must exist, must not be in the future, and must not predate the enrollment start (minus skew). The real emulator attestation carries `creationDateTime` (tag 701). | four creation-time / skew cases |
| O7 | Info: deploy previews proxied to production | `netlify.toml` no longer names any API. `scripts/netlify-api-routing.mjs` writes `_redirects` per environment: the production site goes to the production API only; staging requires `TRUSTID_API_PROXY_ORIGIN` (never production); previews get no API unless a non-production preview API is set. Anything else fails the build, and `/api/*` falls back to 404. | `scripts/tests/netlify-api-routing.test.mjs` |

## Third round (staging trust boundary)

| # | Root cause | Fix | Tests |
|---|---|---|---|
| S1 | `buildApp` required the production LifeOS origin in `CORS_ORIGINS` whenever `NODE_ENV=production`, so a production-mode staging API had to trust a production origin. | `TRUSTID_DEPLOY_ENV` (`apps/api/src/lib/deployment.ts`): unset or `production` with `NODE_ENV=production` → production (unchanged requirements); `staging` → staging; anything else fails. `assertDeploymentSecurity` (`deployment-guard.ts`) runs before any client is bootstrapped. Staging requires an explicit RP ID, passkey origin (within the RP ID), CORS origins and issuer. It refuses every production origin, non-https origins, development flags, `MASTER_DEVICE_ATTESTATION`, connected services pointing at production, a debug certificate and a non-staging Android package. Production also refuses staging origins, the staging package and debug certificates. | `tests/staging-deployment.test.ts` 1–3, 5–11 |
| S2 | `derivedOrigins()` added every `CORS_ORIGINS` entry to the passkey origin list (`config.webauthn.origins`). | Passkey origins are `WEBAUTHN_ORIGIN`, `WEBAUTHN_ORIGINS` and `https://{rpID}` only, in every environment. There are no Related Origin Requests, so production passkeys (RP ID `trustedid.netlify.app`) are unaffected. | test 4 (real WebAuthn verification: the CORS-only origin is refused, the passkey origin accepted) |
| S3 | Boot always created the production Portal clients (production redirects), and the seed upserted development and production clients. | Staging: only `lifeos_*_staging_public` clients from `TRUSTID_STAGING_*_ORIGIN` (validated before anything is created); the ElfCom / mybrandOS defaults and the seed are skipped; start-up fails if the database holds an active client redirecting to production or local hosts. Production and development behave as before. | tests 12, 13, the foreign-client, invalid-configuration and seed tests |
| S4 | `apps/web/public/.well-known/assetlinks.json` stated the debug certificate for every deployment, including previews. | `scripts/netlify-asset-links.mjs` generates statements per environment (`get_login_creds` only). It refuses debug certificates and the other environment's package. Staging fails without its certificate. Production serves none until a release certificate is configured. A missing file returns 404, not the SPA page. | `scripts/tests/netlify-asset-links.test.mjs` |

## Open findings (owner or reviewer decision)

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| O1 | **High** (pre-existing, release gate) | The distributed APK is a **debug build** signed with a developer machine's debug key (`apps/device/package.json:20` `assembleDebug`, `release.json:5` `development-debug`). The local debug build signs with the same certificate (`8e5eb294…36aa`). Debug builds are `android:debuggable`: anyone with USB debugging access can `run-as com.trustid.device` (read app data, session cookies, WebView storage) and attach DevTools to the WebView (run script in the signed-in session). Anyone holding that debug keystore can sign an update the installed app accepts. Keystore private keys stay non-exportable. | Ship release-signed, non-debuggable builds only (`android-master-device-release-signing.md`). Enrollment stays paused until then. |
| O8 | Info | `sendError` maps every 4xx error with a `statusCode` to `reauthentication_failed` (`routes/step-up.ts:49`). | Map only re-authentication errors; cosmetic. |
| O9 | Info | `WEBAUTHN_ANDROID_ORIGINS` admits native assertions for sign-in as well as re-authentication. Intended, but a debug-key app would be accepted if the debug certificate stayed configured. | Configure only the release certificate's hash (release gate). |
| O10 | Info | `apps/web/.env.device` (bundled `build:device` web shell) targets the production API directly, and `apps/digi-rp` defaults to the production issuer and JWKS. Neither is used by staging: staging Android builds must load the staging origin (Gradle check), and staging APIs set their own issuer. | Keep staging on the live-shell path; give the bundled build an environment-specific API base before using it outside production. |
| O11 | Info | Other Trust Center actions (device approval, promotion, credential revoke) still use the generic `reauthentication` challenge, bound to user and purpose only. | Extend operation binding to them in a later change. |

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
