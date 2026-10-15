# T3 independent security review checklist

For the reviewer of PR #3 (`feat/android-master-device`). The implementer's self-review
(`android-master-device-self-review.md`) is input to this review, not a substitute for it. Mark each
item **Pass / Fail / N/A** with evidence (file:line, test name, or command output).

## 0. Scope and baseline
- [ ] Diff is `fc32eca..HEAD` only. `apps/api/src/routes/trust-id.ts` is unchanged. The legacy register still refuses signing keys, and legacy approvals still verify P-256 signatures (`tests/master-device-containment.test.ts`).
- [ ] Production cannot enroll: `MASTER_DEVICE_ENROLLMENT` must equal `enabled`; `MASTER_DEVICE_ATTESTATION=off` is ignored when `NODE_ENV=production`.

## 1. Android Key Attestation (`apps/api/src/modules/step-up/android-key-attestation.ts`)
- [ ] DER parsing: lengths, truncation, high tag numbers, integer size limits. No exception escapes as acceptance.
- [ ] Chain:
  - [ ] each signature checked against the next certificate;
  - [ ] CA flag above the leaf;
  - [ ] validity within the bounded skew;
  - [ ] root pinned by SPKI to Google's RSA and EC roots;
  - [ ] chain length limits.
- [ ] Revocation: every status-list entry is distrusted; an unreachable or malformed list fails closed (503); the cache lifetime is acceptable.
- [ ] The leaf key equals the enrolled key; the challenge equals `sha256("trustid-master-device-attest/v1:" + nonce)`.
- [ ] The **hardware-enforced** list is required for each of these:
  - [ ] purpose SIGN;
  - [ ] EC, P-256, SHA-256;
  - [ ] origin GENERATED;
  - [ ] userAuthType = biometric only;
  - [ ] no authTimeout;
  - [ ] rootOfTrust.

  Also confirm that no property is accepted from the software-enforced list alone.
- [ ] Security levels (attestation and KeyMint) ≥ TEE, and StrongBox when the policy requires it. Verified boot and a locked bootloader are required.
- [ ] Attestation version ≥ 3. `creationDateTime` exists, is not in the future, and is not older than the enrollment start minus skew.
- [ ] Application id: exactly one package, and every signer digest is in the allow-list.

## 2. Enrollment ceremony (`master-device-enrollment.ts`, `routes/step-up.ts`)
- [ ] Tokens: HMAC-sealed with a key derived from `COOKIE_SECRET`; bound to subject, session, key hash, enrollment state and expiry; the version field separates enrollment (v2) from removal (v3) tokens.
- [ ] Proof of possession over server bytes. The attestation challenge comes from the same nonce.
- [ ] Passkey with UV: the UV flag comes from authenticator data; the challenge is HMAC-bound to `enroll|subject|session|nonce|key`; the purpose is `master_device_reauth`; consumption is atomic. Generic reauth challenges are refused.
- [ ] Single enrollment per state (`claimOnce`). Concurrent completions leave exactly one active device. A failed write releases the claim.
- [ ] Recovery hold after a passkey-only removal; nothing can bypass it.
- [ ] `device_fingerprint` reuse across users is refused.

## 3. Approvals (`step-up/service.ts`)
- [ ] The signature covers challenge, subject, client, action, operation digest, RP session hash, device and expiry.
- [ ] Single approval under concurrency. Consumption is bound to client, RP session and operation. Expired, denied and cancelled challenges cannot be consumed.
- [ ] A revoked device cannot approve. Removal cancels pending **and approved-unconsumed** challenges.

## 4. Removal
- [ ] `revoke/begin` issues a single-use (nonce claim), 5-minute removal with bound passkey options.
- [ ] Device signature over `trustid-master-device-revoke/v2` (sub, device, nonce, exp). v1 is refused by the server and by the native signer.
- [ ] The token is bound to session and device. A stale device gives 409; an expired token gives 410.

## 5. Android app (`apps/device/native/android/*.kt`, Gradle, manifest)
- [ ] Key spec:
  - [ ] P-256 SIGN, SHA-256;
  - [ ] `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` on API 30+, validity −1 below;
  - [ ] invalidated on new biometric enrollment;
  - [ ] StrongBox preferred;
  - [ ] software keystore refused and the key deleted.
- [ ] `sign()` accepts only the three TrustID payload formats (strict grammar), and the prompt is built from the payload. Check that web content cannot influence the prompt text or sign arbitrary bytes.
- [ ] Emulator override: requires `BuildConfig.DEBUG`, an emulator and the flag. It is unreachable in release builds.
- [ ] Release builds are not debuggable and are signed only via `TRUSTID_RELEASE_*` environment variables, never the debug key.
- [ ] Backup and device transfer are excluded for all domains.
- [ ] A staging build cannot load or update from production.
- [ ] Credential Manager: `PasskeyPlugin` passes the server request JSON unchanged, and the server enforces UV and the origin allow-list.

## 6. Web (`apps/web/src/lib/masterDeviceNative.ts`, `reauth.ts`, `StepUpRequests.tsx`)
- [ ] The client refuses to sign enrollment or removal bytes that name another subject, key or device.
- [ ] Keys are kept only after server acceptance and deleted on failure.

## 7. Configuration and deployment
- [ ] `netlify.toml` names no API. The routing generator fails closed. Previews never reach production.
- [ ] Digital Asset Links: production lists only the release certificate. Staging lists only the staging package and certificate.
- [ ] `WEBAUTHN_ANDROID_ORIGINS` and `ANDROID_APP_SIGNING_SHA256` hold only the release certificate in production and only the staging certificate in staging.
- [ ] No secrets in Git: keystore patterns are ignored, and GitGuardian is clean.

## 7b. Staging trust boundary (`apps/api/src/lib/deployment*.ts`, `portal-oauth-clients.ts`, `bootstrap-oauth-apps.ts`, `prisma/seed.ts`)
- [ ] Unknown `TRUSTID_DEPLOY_ENV` fails. Staging requires `NODE_ENV=production`. Unset in production keeps the production rules.
- [ ] Staging refuses every production origin (TrustID, LifeOS, `*-production.up.railway.app`) in RP ID, passkey origins, CORS, issuer, Portal redirects and connected services. Production refuses staging origins.
- [ ] Passkey origins never include `CORS_ORIGINS`.
- [ ] Staging registers only its own Portal clients, seeds nothing, and refuses a database holding production or local relying parties.
- [ ] Android identity per environment (package, certificate). Debug certificates are refused by the API guard and the Digital Asset Links generator.

## 8. Audit and privacy
- [ ] Every enrollment failure, approval failure, denial, expiry, revocation and legacy issuance is audited with a reason.
- [ ] Sessions appear as hashes. The activity view exposes no IPs, user agents, keys, signatures or tokens.

## 9. Evidence still required beyond code review
- [ ] Physical-device acceptance (`android-master-device-device-acceptance.md`) on a TEE phone and a StrongBox phone with the staging-signed app.
- [ ] Release signing and the coordinated Digital Asset Links / API configuration (`android-master-device-release-signing.md`).
