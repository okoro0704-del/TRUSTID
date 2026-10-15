# T3 physical-device acceptance plan

Purpose: produce the physical-device evidence the emulator cannot. That evidence is:

- a real Google-rooted attestation from a TEE and from a StrongBox;
- native passkeys through Credential Manager with user verification;
- hardware biometric gating on real sensors.

**Preconditions (all required; none are met yet):**

- Owner authorization naming the two test phones. These are dedicated test devices, **not** the
  owner's personal OPPO phone, unless the owner explicitly authorizes it in writing.
- Test TrustID accounts only. No real-user records.
- Isolated staging (`android-master-device-staging.md`): staging API, staging database, staging RP
  ID, staging Digital Asset Links, `MASTER_DEVICE_ENROLLMENT=enabled` **on staging only**.
- App built from the reviewed commit and signed with the **staging** signing identity:
  `release` build type, not debuggable.
- Production untouched: `MASTER_DEVICE_ENROLLMENT` unset; no production configuration changes.

## Devices

| ID | Requirement | Check before testing |
|---|---|---|
| D1 (TEE) | Android 11+ (per-use biometric keys), Class 3 fingerprint, locked bootloader, Play services, no StrongBox | `adb shell pm has-feature android.hardware.strongbox_keystore` → false; Settings shows the bootloader locked; security patch level recorded |
| D2 (StrongBox) | Android 11+, StrongBox (e.g. Pixel 3+ / Titan M), Class 3 biometric, locked bootloader | `has-feature android.hardware.strongbox_keystore` → true |
| D3 (optional) | Android 9 or 10 phone | exercises the `setUserAuthenticationValidityDurationSeconds(-1)` path |

Record for each device: model, Android version, patch level, the attestation chain (saved as
evidence; public certificates only), the verifier result, and the server audit events.

## Test matrix

Run every case on D1 and D2 unless marked. "Expected" is the pass criterion.

| # | Case | Steps | Expected |
|---|---|---|---|
| A1 | Native passkey registration | Create a test account in the app; register a passkey | Credential Manager sheet appears; passkey stored; registration succeeds |
| A2 | Native passkey authentication with UV | Sign out; sign in with the passkey | System sheet asks for fingerprint/screen lock; server accepts an assertion with origin `android:apk-key-hash:<staging cert>` and the UV flag |
| A3 | UV is enforced | Revoke flow with a passkey and cancel at the verification prompt | Server refuses (no assertion, or `401 reauthentication_failed`) |
| A4 | DAL negative | Install a build signed with another key; try passkey sign-in | Credential Manager offers no TrustID passkey (`no_credential`) or the server refuses the origin |
| B1 | Hardware enrollment | Trust Center → make this phone the Master Device; fingerprint; passkey | `registered: true`; `security_level` `tee` on D1 / `strongbox` on D2; audit `master_device.registered` with verifiedBoot true |
| B2 | Real attestation evidence | Export the chain from B1 (debug log of `generateKey` result in the staging build, or server-side capture) and run the verifier offline | Chain ends at a pinned Google root; `origin` GENERATED, `userAuthType` 2 and no `authTimeout` in the **hardware-enforced** list; app id equals the staging package and certificate; not on the status list |
| B3 | StrongBox policy | Staging `ANDROID_ATTESTATION_MIN_LEVEL=strongbox`; enroll D1 and D2 | D1 refused `security_level_tee`; D2 accepted |
| B4 | Replay | Resend the B1 `complete` body | `409`/`410`; still one active device |
| C1 | Approval | Staging Portal requests step-up; approve on the phone | Prompt shows `Approve: <action>` / `Requested by <client>` from the payload; Portal consumes once |
| C2 | Denial | Request; Decline | Challenge `denied`; Portal gets no approval; audit `step_up.challenge_denied` |
| C3 | Expiry | Request; wait past the expiry | Approval refused `410`; audit `step_up.challenge_expired` |
| C4 | Approval replay | Reuse an approved challenge's signature, or consume twice | Second attempt refused |
| D1c | Biometric cancel | Approve → cancel the prompt | No signature; UI says cancelled; challenge stays pending |
| D2f | Failed biometric | Wrong finger ×N | No signature after any failure; lockout handled; nothing signed |
| D3k | New fingerprint enrolled | Add a fingerprint in Settings, then approve | `key_invalidated`; re-enrollment required (device-signed revoke unavailable; passkey revoke → recovery hold, by design) |
| E1 | Restart persistence | Force-stop and reboot; approve | Same key; approval works |
| F1 | Revocation from the phone | Remove this Master Device (fingerprint + passkey) | Prompt reads "Remove this Master Device"; device revoked; pending **and approved-unconsumed** challenges cancelled; immediate re-enrollment allowed |
| F2 | Revoked key use | After F1, replay an old approval signature, and replay the F1 removal request | Both refused (`403`/`409`/`404`) |
| F4 | Removal expiry | Start a removal; wait more than 5 minutes; confirm | `410 revocation_expired`; device still active |
| F3 | Lost-device revoke | Revoke from another session with passkey only | Revoked; `recovery_required`; new enrollment blocked |
| G1 | Offline | Airplane mode during approval | Clean error; key intact; no partial state |
| G2 | Network recovery | Re-enable network; retry | Approval succeeds if not expired |
| H1 | Debug → release migration (one device) | Install the old debug build; sign in; then install the release build | OTA refuses (`SIGNER_MISMATCH`); install over it fails; after uninstall + install, passkey sign-in works and no Master Device was carried over |
| H2 | Release build hardening | `adb shell run-as <package>`; `chrome://inspect` | `run-as` refused (not debuggable); WebView not inspectable |
| I1 | Clock skew (O6) | Set the phone clock +10 min; enroll | Record whether `certificate_validity_0` occurs |

## Evidence and exit criteria

- For each case: device, build hash, timestamps, the server audit events and the expected result.
  Never capture private keys, passkey material, biometric data or full tokens.
- **Pass:** every A–H case passes on D1 and D2. B2 shows the hardware-enforced properties from a
  real Google root.
- Any failure: stop, record, and fix through review. Production stays paused.
