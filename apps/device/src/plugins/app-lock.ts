import { registerPlugin } from "@capacitor/core";
import type { AppLockPolicy } from "@trustid/device-security";

export type AppLockPlugin = {
  getPolicy(): Promise<AppLockPolicy>;
  setPolicy(options: { policy: AppLockPolicy }): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  isAccessibilityEnabled(): Promise<{ enabled: boolean }>;
  challengeNow(options: { packageId: string }): Promise<{ ok: boolean }>;
};

export const TrustIdAppLock = registerPlugin<AppLockPlugin>("TrustIdAppLock");
