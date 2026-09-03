/**
 * Wire Capacitor plugins into window bridges used by tier1 security helpers.
 * Keeps @trustid/web free of an @trustid/device package dependency.
 */
import type { AppLockPolicy } from "@trustid/device-security";

type CapPlugin = {
  [method: string]: (opts?: unknown) => Promise<unknown>;
};

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  registerPlugin?: (name: string) => CapPlugin;
  Plugins?: Record<string, CapPlugin>;
};

function getCap(): CapacitorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
}

function plugin(name: string): CapPlugin | undefined {
  const cap = getCap();
  if (!cap?.isNativePlatform?.()) return undefined;
  if (cap.Plugins?.[name]) return cap.Plugins[name];
  try {
    return cap.registerPlugin?.(name);
  } catch {
    return undefined;
  }
}

/** Call once at app boot before App Locker / Media Vault controllers are created. */
export function injectCapacitorSecurityBridges(): boolean {
  const cap = getCap();
  if (!cap?.isNativePlatform?.()) return false;

  const bio = plugin("TrustIdBiometricGate");
  if (bio && !window.TrustIdBiometricGate) {
    window.TrustIdBiometricGate = {
      getAvailability: () =>
        bio.getAvailability() as Promise<
          import("@trustid/device-security").BiometricAvailability
        >,
      authenticate: (options) =>
        bio.authenticate(options) as Promise<{ ok: boolean; method: string }>,
    };
  }

  const media = plugin("TrustIdMediaVault");
  if (media && !window.TrustIdMediaVault) {
    window.TrustIdMediaVault = media as unknown as NonNullable<
      Window["TrustIdMediaVault"]
    >;
  }

  const lock = plugin("TrustIdAppLock");
  if (lock && !window.TrustIdAppLock) {
    window.TrustIdAppLock = {
      getPolicy: async () => (await lock.getPolicy()) as AppLockPolicy,
      setPolicy: async (policy: AppLockPolicy) => {
        await lock.setPolicy({ policy });
      },
      openAccessibilitySettings: async () => {
        await lock.openAccessibilitySettings();
      },
      openOverlayPermissionSettings: async () => {
        await lock.openOverlayPermissionSettings?.();
      },
      canDrawOverlays: async () =>
        (await lock.canDrawOverlays?.()) as { granted: boolean },
      isAccessibilityEnabled: async () =>
        (await lock.isAccessibilityEnabled()) as { enabled: boolean },
      challengeNow: async (packageId: string) =>
        (await lock.challengeNow({ packageId })) as { ok: boolean },
      getInstalledApps: async (options?: { includeIcons?: boolean }) =>
        (await lock.getInstalledApps(options ?? {})) as {
          apps: Array<{
            packageId: string;
            displayName: string;
            iconBase64?: string;
          }>;
          platform: string;
          note?: string;
        },
      setLockedApps: async (packages: string[]) =>
        (await lock.setLockedApps({ packages })) as {
          ok: boolean;
          count: number;
        },
      requestFamilyControlsAuth: async () =>
        ((await lock.requestFamilyControlsAuth?.()) as {
          authorized: boolean;
          message?: string;
        }) ?? { authorized: false, message: "unavailable" },
    };
  }

  return Boolean(window.TrustIdAppLock || window.TrustIdBiometricGate);
}

export function isNativeCapacitorShell(): boolean {
  try {
    return getCap()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}
