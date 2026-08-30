/**
 * Shared Capacitor bridge surface for Trust ID App Locker.
 * Native Android: AccessibilityService + SYSTEM_ALERT_WINDOW + OverlayGuardActivity.
 * Native iOS: FamilyControls / ManagedSettings shields + SceneBlurHandler.
 */

export type InstalledAppInfo = {
  packageId: string;
  displayName: string;
  systemApp?: boolean;
  /** Optional PNG base64 when includeIcons=true (Android). */
  iconBase64?: string;
};

export type GetInstalledAppsResult = {
  apps: InstalledAppInfo[];
  platform: "android" | "ios" | "web" | string;
  note?: string;
};

export type SetLockedAppsResult = {
  ok: boolean;
  count: number;
};

export type AppLockNativeBridge = {
  getInstalledApps(options?: { includeIcons?: boolean }): Promise<GetInstalledAppsResult>;
  setLockedApps(packages: string[]): Promise<SetLockedAppsResult>;
  openAccessibilitySettings?(): Promise<void>;
  openOverlayPermissionSettings?(): Promise<void>;
  canDrawOverlays?(): Promise<{ granted: boolean }>;
  isAccessibilityEnabled?(): Promise<{ enabled: boolean }>;
  requestFamilyControlsAuth?(): Promise<{ authorized: boolean; message?: string }>;
};

/**
 * Query all launchable device applications for the in-app picker.
 */
export async function getInstalledApps(
  bridge: AppLockNativeBridge,
  options?: { includeIcons?: boolean },
): Promise<GetInstalledAppsResult> {
  return bridge.getInstalledApps(options);
}

/**
 * Synchronize the locked package/bundle list with native OS registries
 * (Android Accessibility prefs + iOS ManagedSettings selection).
 */
export async function setLockedApps(
  bridge: AppLockNativeBridge,
  packages: string[],
): Promise<SetLockedAppsResult> {
  return bridge.setLockedApps(packages);
}

export async function ensureAndroidOverlayPermission(
  bridge: AppLockNativeBridge,
): Promise<boolean> {
  if (!bridge.canDrawOverlays || !bridge.openOverlayPermissionSettings) {
    return false;
  }
  const { granted } = await bridge.canDrawOverlays();
  if (granted) return true;
  await bridge.openOverlayPermissionSettings();
  const again = await bridge.canDrawOverlays();
  return again.granted;
}
