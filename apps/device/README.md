# TrustID Device (`@trustid/device`)

Capacitor shell that hosts the Trust Center **web/PWA** and registers native Tier 1 plugins for biometric vault + app locker.

## What builds where

| Surface | Status | Command |
|---------|--------|---------|
| Web + PWA | Production (Netlify) | `npm run build -w @trustid/web` |
| Android app | Capacitor project in `android/` | `npm run android -w @trustid/device` |
| iOS app | Capacitor project in `ios/` (build on macOS) | `npm run ios -w @trustid/device` |

## Daily workflow

```bash
# From repo root — rebuild web, sync plugins into native projects
npm run cap:sync -w @trustid/device

# Open Android Studio (Windows/macOS/Linux with Android SDK)
npm run android -w @trustid/device

# Open Xcode (macOS + CocoaPods required)
npm run ios -w @trustid/device
```

`cap:sync` will:

1. Build `@trustid/web` into `apps/web/dist`
2. Build `@trustid/device` TypeScript
3. Copy Kotlin/Swift plugins via `scripts/sync-native.mjs`
4. Run `npx cap sync`

## First-time setup (already done in-repo)

Projects were generated with:

```bash
npm run build -w @trustid/web
cd apps/device
npx cap add android
npx cap add ios
node ./scripts/sync-native.mjs
npx cap sync
```

If `android/` or `ios/` are missing on a fresh clone:

```bash
npm run cap:add:android -w @trustid/device
# macOS only for a full iOS toolchain:
npm run cap:add:ios -w @trustid/device
npm run cap:sync -w @trustid/device
```

## Plugins

| Plugin | Role |
|--------|------|
| `TrustIdBiometricGate` | BiometricPrompt / LocalAuthentication, strong-only by default |
| `TrustIdMediaVault` | Keystore DEK + AES-GCM files + MediaStore delete request |
| `TrustIdAppLock` | AccessibilityService foreground intercept + overlay (Android) |

Source of truth for native code: `native/android` and `native/ios`.  
Synced copies live under `android/app/src/main/java/...` and `ios/App/App/plugins/`.

### Build a debug APK (Windows)

```bash
# From repo root — sync + assemble + copy to stable path
npm run android:apk -w @trustid/device
```

Stable install file (always overwrite this same path):

```text
TrustID-debug.apk
```

Also written to: `artifacts/apk/TrustID-debug.apk`  
Gradle output: `apps/device/android/app/build/outputs/apk/debug/app-debug.apk`

### Live updates on launch (default)

The Capacitor shell loads **https://trustedid.netlify.app** by default.
After you push to `main` and Netlify deploys, reopen the app to get web/UI/auth changes without reinstalling.

Rebuild the APK when native plugins or Capacitor config change.

Opt out of live web (use bundled `web/dist` only):

```bash
set CAP_USE_LIVE_WEB=0
npm run android:apk -w @trustid/device
```

### iOS (macOS)

1. `cd apps/device/ios/App && pod install`
2. Add `plugins/*.swift` to the Xcode App target if not already (File → Add Files)
3. Enable Face ID usage description in Info.plist (`NSFaceIDUsageDescription`)
4. Build/run from Xcode

Cross-app launch interception is **not** available on iOS. Vault + in-app biometric gate still work via Secure Enclave when entitlements are configured.

## Package identity

- App ID: `com.trustid.device`
- Web assets: `apps/web/dist` (see `capacitor.config.ts` → `webDir`)
