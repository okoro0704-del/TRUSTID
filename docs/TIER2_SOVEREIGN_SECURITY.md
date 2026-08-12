# Tier 2 — Sovereign Sync, Guardians & Attestation

Cross-device trust hardening on top of Tier 1 local vault controls. The TrustID API remains a **blind relay** and policy enforcer — it never holds X3DH session keys, Shamir master secrets, or vault plaintext.

## 1. Encrypted device-to-device sync (X3DH-inspired)

**Protocol:** Signal-family X3DH over X25519 + Ed25519 signed prekeys ? HKDF-SHA-256 ? AES-256-GCM.

| Step | Client | Server |
|------|--------|--------|
| Publish | Generate IK / SPK / OPKs; keep privates in IndexedDB | Store **public** bundle only (`DeviceSyncPrekeyBundle`) |
| Initiate | Fetch peer bundle; run `x3dhInitiate`; seal payload | Queue opaque `DeviceSyncEnvelope` |
| Respond | `x3dhRespond` + `openWithSessionKey` | Mark envelope consumed |

Package: `@trustid/sovereign-crypto`  
API: `PUT /sync/prekeys`, `GET /sync/prekeys/:deviceId`, `POST /sync/envelopes`, `GET /sync/inbox/:deviceId`, `POST .../consume`  
UI: `/dashboard/device-sync`

## 2. Social / cryptographic recovery guardians (Shamir)

**Protocol:** Shamir SSS over GF(256), threshold `t`-of-`n`.

1. Client generates 32-byte recovery master secret.
2. `splitSecret` ? n shares; `commitSecret` (SHA-256) stored server-side.
3. Each share uploaded as opaque `shareCiphertext` with a one-time invite code (hashed at rest).
4. Guardians claim via `POST /recovery/guardians/claim` (no PII).
5. Reconstruction is **client-side** (`combineShares`); server only tracks share-index progress toward threshold.

API: `/recovery/guardians/*`, `/recovery/status`  
UI: `/dashboard/guardians`

Recovery never bypasses primary-device policy: after reconstructing the secret, the user still enrolls a new platform passkey through normal device trust flows.

## 3. Hardware enclave attestation (MDS-inspired)

| Env | Purpose |
|-----|---------|
| `WEBAUTHN_ATTESTATION` | `none` (default) \| `direct` \| `indirect` \| `enterprise` |
| `WEBAUTHN_ATTESTATION_MODE` | `off` \| `soft` (default when attestation ? none) \| `strict` |
| `WEBAUTHN_MIN_SECURITY_LEVEL` | `software` \| `tee` \| `secure_hardware` (default `tee`) |
| `WEBAUTHN_REQUIRE_KNOWN_AAGUID` | `true` to reject unknown AAGUIDs in soft/strict |

On registration, TrustID evaluates the authenticator **AAGUID** against a built-in MDS-inspired catalog (`modules/attestation/mds.ts`). Results are audited and stored on `Credential` (`attestationSecurityLevel`, `attestationStatus`).

- **soft:** unknown / low level ? register + `device.attestation.soft_fail`
- **strict:** unknown / low level ? **403** + `device.attestation.rejected`

## Packages & modules

| Path | Role |
|------|------|
| `packages/sovereign-crypto` | X3DH, Shamir, seal helpers |
| `apps/api/src/modules/device-sync` | Blind relay service |
| `apps/api/src/modules/recovery` | Guardian circles |
| `apps/api/src/modules/attestation` | MDS catalog + policy |
| `apps/web/src/lib/security/sovereign.ts` | Client integration |

## Threat notes

- Blind relay does not stop a compromised client device.
- Invite codes are capability URLs — treat like recovery codes.
- Built-in MDS catalog is a starting set; production should refresh from FIDO Alliance MDS.
