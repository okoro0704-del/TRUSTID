# TrustID Device (`@trustid/device`)

Capacitor shell that hosts the Trust Center PWA and registers native Tier 1 plugins.

## One-time native project bootstrap

```bash
npm install
npm run build -w @trustid/web
npm run build -w @trustid/device
cd apps/device
npx cap add android
npx cap add ios   # macOS + Xcode only
```

Then copy sources from `native/android` and `native/ios` into the generated projects (see comments in each file), grant permissions in manifests, and:

```bash
npx cap sync
npx cap open android
```

## Plugins

| Plugin | Role |
|--------|------|
| `TrustIdBiometricGate` | BiometricPrompt / LocalAuthentication, strong-only by default |
| `TrustIdMediaVault` | Keystore DEK + AES-GCM files + MediaStore delete request |
| `TrustIdAppLock` | AccessibilityService foreground intercept + overlay |

## iOS limits

Cross-app launch interception is **not** available. App Lock UI explains Screen Time; vault + in-app gate still work via Secure Enclave when entitlements are configured.
