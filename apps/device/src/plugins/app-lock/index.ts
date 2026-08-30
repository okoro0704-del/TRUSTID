import type { AppLockConfig } from "@trustid/vault-sdk";
import { registerPlugin } from "@capacitor/core";

/** Extended app-lock policy including sovereign vault registry fields. */
export type SovereignAppLockPolicy = AppLockConfig;

export type AppLockPlugin = {
  getPolicy(): Promise<SovereignAppLockPolicy>;
  setPolicy(options: { policy: SovereignAppLockPolicy }): Promise<void>;
  setLockedApps(options: { packages: string[] }): Promise<{ ok: boolean; count: number }>;
  getInstalledApps(options?: {
    includeIcons?: boolean;
  }): Promise<{
    apps: Array<{
      packageId: string;
      displayName: string;
      systemApp?: boolean;
      iconBase64?: string;
    }>;
    platform: string;
    note?: string;
  }>;
  openAccessibilitySettings(): Promise<void>;
  openOverlayPermissionSettings(): Promise<void>;
  canDrawOverlays(): Promise<{ granted: boolean }>;
  isAccessibilityEnabled(): Promise<{ enabled: boolean }>;
  challengeNow(options: { packageId: string }): Promise<{ ok: boolean; duress?: boolean }>;
  isDuressBiometricConfigured(): Promise<{ configured: boolean }>;
  requestFamilyControlsAuth?(): Promise<{ authorized: boolean; message?: string }>;
};

export const TrustIdAppLock = registerPlugin<AppLockPlugin>("TrustIdAppLock");
