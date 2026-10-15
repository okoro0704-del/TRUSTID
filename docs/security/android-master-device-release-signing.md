# TrustID Android release signing (T3 release gate)

Status: **not done.** The distributed `TrustID.apk` is a debug build signed with the Android debug
certificate `8E:5E:B2:94:68:BE:EA:2D:36:13:5B:85:00:C3:76:E4:93:27:7A:97:14:0A:69:D1:68:8B:D3:EA:4C:F3:36:AA`
from a developer machine. Nothing in this document has been executed. No release key exists yet.
Generating, uploading or activating one needs the owner's explicit approval.

## Current build facts

| Item | Value |
|---|---|
| Package (`applicationId`) | `com.trustid.device` (`apps/device/release.json`) |
| Distributed build | `assembleDebug` (`apps/device/package.json` `android:apk`), channel `development-debug` |
| Debuggable | yes (debug build): `run-as` and WebView DevTools available over USB debugging |
| Release build type | not debuggable (`debuggable false`); signed **only** when `TRUSTID_RELEASE_KEYSTORE`, `TRUSTID_RELEASE_KEYSTORE_PASSWORD`, `TRUSTID_RELEASE_KEY_ALIAS` and `TRUSTID_RELEASE_KEY_PASSWORD` are all set; otherwise unsigned, never debug-signed |
| Emulator software-key override | needs `BuildConfig.DEBUG` (false in release) |
| OTA updater | refuses an update whose signer differs from the installed app (`SIGNER_MISMATCH`), so moving from debug to release signing cannot happen over OTA |
| Secrets in Git | none. `*.jks`, `*.keystore`, `*.p12`, `*.pk8`, `keystore.properties` and `signing.properties` are ignored (`apps/device/android/.gitignore`) |
| Backup / device transfer | disabled for all app data (`allowBackup=false`, `dataExtractionRules`) |
| Staging identity | `-PtrustidEnv=staging -PtrustidStagingOrigin=…` → `com.trustid.device.staging`, staging origin and OTA only; signed with a separate **staging** key through the same `TRUSTID_RELEASE_*` variables |
| APK check | `scripts/verify-android-apk.mjs` (package, not debuggable, backup off, web origin, signer); runs in CI for the staging build |

## Decisions for the owner

1. **Package identity.** Recommended: keep `com.trustid.device`. Attestation policy, Digital Asset
   Links and docs already use it. Because the signer changes, users must uninstall the debug app
   anyway. Alternative: a new id such as `com.trustid.app`, which lets both apps be installed side
   by side during migration but changes `ANDROID_APP_PACKAGE`, the DAL `package_name` and OTA.
2. **Distribution.** Website OTA (current) or Google Play. With Play App Signing, Google holds the
   app signing key. The attested signing digest and the DAL fingerprint are then **Google's app
   signing certificate**, not the upload key.
3. **Key custody** (if self-managed): an offline key or a cloud KMS / HSM key.

## Procedure (self-managed key)

1. **Generate**, on an offline or dedicated machine, with the owner present: an RSA 4096 (or EC
   P-256) key with a validity of 30 years or more, in a PKCS12 keystore with a strong passphrase.
   Never on a developer workstation. Never in CI.
2. **Back up**: two encrypted copies on separate offline media in separate physical locations. Put
   the passphrases in the owner's password manager plus one sealed escrow. Record the SHA-256
   certificate fingerprint in the security log.
3. **Sign**, in one of two ways:
   - locally on the offline machine (`apksigner sign` with v2 and v3 signatures); or
   - in a protected CI environment (GitHub Environment with required reviewers, tag builds only),
     with the keystore supplied as a secret file and the four `TRUSTID_RELEASE_*` variables.

   Verify with `apksigner verify --print-certs --verbose` and confirm `debuggable` is false
   (`aapt dump badging`).
4. **Rotation**: keep APK Signature Scheme v3, so a future key can be rotated in with a
   proof-of-rotation lineage (`apksigner rotate`) without another reinstall. On rotation, the
   attestation allow-list and the DAL must list both certificates for the overlap period.
5. **Compromise response**:
   - remove the certificate from `ANDROID_APP_SIGNING_SHA256`, `WEBAUTHN_ANDROID_ORIGINS` and the
     DAL;
   - pause `MASTER_DEVICE_ENROLLMENT`;
   - revoke the Master Devices enrolled with that app identity (audit metadata names their
     platform).

## Coordinated configuration change (one release window, owner-approved)

Derive all three values from the same release certificate SHA-256 (`<HEX>` = 64 hex chars):

| Where | Format | Example of form |
|---|---|---|
| `apps/web/public/.well-known/assetlinks.json` `sha256_cert_fingerprints` | uppercase hex, colon-separated | `AB:CD:…` |
| API `ANDROID_APP_SIGNING_SHA256` | lowercase hex, no colons | `abcd…` |
| API `WEBAUTHN_ANDROID_ORIGINS` | `android:apk-key-hash:` + base64url (no padding) of the raw 32 bytes | `android:apk-key-hash:q80…` |

Checklist (in order):

1. Build the release APK; record `apksigner --print-certs` output.
2. Update `assetlinks.json` to the release fingerprint **only**. Remove the debug fingerprint; any
   holder of the debug key could otherwise obtain passkey assertions.
3. Deploy the web and verify `https://trustedid.netlify.app/.well-known/assetlinks.json` returns
   `200 application/json` (production currently serves the SPA `text/html` there). Check it with
   Google's Digital Asset Links API: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://trustedid.netlify.app&relation=delegate_permission/common.get_login_creds`.
4. Set `ANDROID_APP_PACKAGE`, `ANDROID_APP_SIGNING_SHA256` and `WEBAUTHN_ANDROID_ORIGINS` on the API.
   Keep `MASTER_DEVICE_ENROLLMENT` unset.
5. Publish the release APK and an OTA manifest whose `signerSha256` is the release certificate.
   Installed debug apps will report `SIGNER_MISMATCH`; they need the manual migration below.
6. Run physical-device acceptance with the release-signed app (`android-master-device-device-acceptance.md`).
7. Only then, with owner approval: `MASTER_DEVICE_ENROLLMENT=enabled`.

## Debug → release migration for installed apps

Uninstalling deletes app data: WebView session, app-lock settings, the local media vault
(`filesDir`) and every Keystore key. Production has no T3 Master Devices, because enrollment is
paused. **Migrate before enabling enrollment**, so no user loses a Master Device to the
recovery hold. User steps:

1. Export anything held only in the app (media vault).
2. Uninstall TrustID (debug).
3. Install the release build.
4. Sign in with a passkey.

Passkeys live in the platform credential store and survive the reinstall.
