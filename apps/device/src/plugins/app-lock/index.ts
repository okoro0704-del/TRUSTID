import type { AppLockConfig } from "@trustid/vault-sdk";
import { registerPlugin } from "@capacitor/core";

/** Extended app-lock policy including sovereign vault registry fields. */
export type SovereignAppLockPolicy = AppLockConfig;

export type AppLockPlugin = {
  getPolicy(): Promise<SovereignAppLockPolicy>;
  setPolicy(options: { policy: SovereignAppLockPolicy }): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  isAccessibilityEnabled(): Promise<{ enabled: boolean }>;
  challengeNow(options: { packageId: string }): Promise<{ ok: boolean; duress?: boolean }>;
  /** Native duress finger/face slot detection (Android BiometricPrompt / iOS LAContext). */
  isDuressBiometricConfigured(): Promise<{ configured: boolean }>;
};

export const TrustIdAppLock = registerPlugin<AppLockPlugin>("TrustIdAppLock");

/**
 * Native plugin specification — Android/iOS implementation notes:
 *
 * Android (`AppLockPlugin.kt`):
 * - Mirror `SovereignAppLockPolicy` JSON into `AppLockAccessibilityService` prefs.
 * - `challengeNow` ? `AppLockOverlayActivity` with BiometricPrompt.
 * - Duress: register alternate biometric via `setNegativeButton` hidden path or
 *   dedicated `BiometricManager` authenticator; on duress match return `{ duress: true }`.
 *
 * iOS (`AppLockPlugin.swift`):
 * - Cross-app intercept limited; expose in-app route shield + Shortcuts hidden apps list.
 * - Duress via separate LAContext policy evaluation flag.
 */
