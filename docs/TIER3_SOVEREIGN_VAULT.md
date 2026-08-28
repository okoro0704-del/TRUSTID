# Sovereign Vault & Privacy Shield (Tier 3)

Client-side security layer extending Tier 1 `@trustid/device-security` with hardware-backed DAK/CDK architecture, encrypted sovereign file system (eSFS), app lock registry, risk-based step-up, and duress handling.

## Packages

| Package | Role |
|---------|------|
| `@trustid/vault-sdk` | DAK/CDK crypto, eSFS, policy engine, app lock registry, duress |
| `@trustid/device-security` | Tier 1 biometric gate, media vault, app lock (unchanged API) |
| `apps/device` | Capacitor plugins: `TrustIdSovereignVault`, extended `TrustIdAppLock` |

## Architecture

```
BiometricGate (OS UV / WebAuthn)
        ?
        ?
   DakSession ??HKDF??? CDK per chunk
        ?
        ?
 EncryptedSovereignFileSystem (eSFS) — AES-256-GCM at rest
        ?
 RouteGuard ??? StepUpController ??? Risk policy engine
        ?
 DuressHandler ??? ElfCom emergency push (optional)
```

## Zero-server knowledge

- Video/media encrypted in eSFS before persistence.
- DAK unlocked only after biometric; CDK derived per chunk in memory.
- Native: DAK in Android Keystore StrongBox / iOS Secure Enclave via `TrustIdSovereignVault`.
- Web: software DAK gated by WebAuthn UV (same as Tier 1 gate).

## Native plugin specs

See inline JSDoc in:

- `apps/device/src/plugins/sovereign-vault.ts`
- `apps/device/src/plugins/app-lock/index.ts`

## Tests

```bash
npm run test -w @trustid/vault-sdk
```
