import { DEFAULT_APP_LOCK_POLICY, type AppLockPolicy, type LockedApp } from "../types.js";
import type { BiometricGate } from "../biometric/gate.js";

const STORAGE_KEY = "trustid.app_lock_policy.v1";

export type NativeAppLockBridge = {
  getPolicy(): Promise<AppLockPolicy>;
  setPolicy(policy: AppLockPolicy): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  isAccessibilityEnabled(): Promise<{ enabled: boolean }>;
  /** Trigger overlay challenge (used by tests / manual). */
  challengeNow(packageId: string): Promise<{ ok: boolean }>;
  getInstalledApps?(options?: { includeIcons?: boolean }): Promise<{
    apps: Array<{ packageId: string; displayName: string; iconBase64?: string }>;
    platform: string;
    note?: string;
  }>;
  setLockedApps?(packages: string[]): Promise<{ ok: boolean; count: number }>;
  openOverlayPermissionSettings?(): Promise<void>;
  canDrawOverlays?(): Promise<{ granted: boolean }>;
  requestFamilyControlsAuth?(): Promise<{ authorized: boolean; message?: string }>;
};

/**
 * Manages the locked-app set and policy.
 * On Android Device app, policy is mirrored into AccessibilityService preferences.
 */
export class AppLockController {
  constructor(
    private readonly gate: BiometricGate,
    private readonly native?: NativeAppLockBridge,
  ) {}

  async getPolicy(): Promise<AppLockPolicy> {
    if (this.native) return this.native.getPolicy();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_APP_LOCK_POLICY, apps: [] };
      return { ...DEFAULT_APP_LOCK_POLICY, ...JSON.parse(raw) } as AppLockPolicy;
    } catch {
      return { ...DEFAULT_APP_LOCK_POLICY, apps: [] };
    }
  }

  async savePolicy(policy: AppLockPolicy): Promise<void> {
    await this.gate.authenticate({
      reason: "Confirm App Locker policy change",
      allowDeviceCredential: policy.allowDeviceCredential,
      strongOnly: policy.biometricStrongOnly,
    });
    if (this.native) {
      await this.native.setPolicy(policy);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(policy));
  }

  async setEnabled(enabled: boolean): Promise<AppLockPolicy> {
    const policy = await this.getPolicy();
    const next = { ...policy, enabled };
    await this.savePolicy(next);
    return next;
  }

  async addApp(app: Omit<LockedApp, "addedAt">): Promise<AppLockPolicy> {
    const policy = await this.getPolicy();
    if (policy.apps.some((a) => a.packageId === app.packageId)) return policy;
    const next: AppLockPolicy = {
      ...policy,
      apps: [
        ...policy.apps,
        { ...app, addedAt: new Date().toISOString() },
      ],
    };
    await this.savePolicy(next);
    return next;
  }

  async removeApp(packageId: string): Promise<AppLockPolicy> {
    const policy = await this.getPolicy();
    const next = {
      ...policy,
      apps: policy.apps.filter((a) => a.packageId !== packageId),
    };
    await this.savePolicy(next);
    return next;
  }

  async accessibilityStatus(): Promise<{
    supported: boolean;
    enabled: boolean;
    note: string;
  }> {
    const avail = await this.gate.getAvailability();
    if (!avail.appLockSupported || !this.native) {
      return {
        supported: false,
        enabled: false,
        note:
          avail.platform === "ios"
            ? "iOS does not allow third-party cross-app launch interception. Use Screen Time / Focus, or Android TrustID Device for process shield."
            : "Install TrustID Device (Android) and enable the Accessibility service for App Locker.",
      };
    }
    const { enabled } = await this.native.isAccessibilityEnabled();
    return {
      supported: true,
      enabled,
      note: enabled
        ? "Accessibility process shield is active."
        : "Enable TrustID App Lock in Android Accessibility settings.",
    };
  }

  async openNativeSettings(): Promise<void> {
    if (!this.native) {
      throw new Error("Native App Lock bridge unavailable");
    }
    await this.native.openAccessibilitySettings();
  }

  async getInstalledApps(options?: { includeIcons?: boolean }) {
    if (!this.native?.getInstalledApps) {
      return {
        apps: [] as Array<{ packageId: string; displayName: string }>,
        platform: "web",
        note: "Install TrustID Device for the native app picker.",
      };
    }
    return this.native.getInstalledApps(options);
  }

  async setLockedApps(packages: string[]) {
    if (this.native?.setLockedApps) {
      return this.native.setLockedApps(packages);
    }
    const policy = await this.getPolicy();
    const now = new Date().toISOString();
    const apps = packages.map((packageId) => ({
      packageId,
      displayName: packageId,
      addedAt: now,
    }));
    await this.savePolicy({ ...policy, enabled: packages.length > 0, apps });
    return { ok: true, count: packages.length };
  }
}
