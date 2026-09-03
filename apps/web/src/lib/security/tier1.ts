import {
  AppLockController,
  MediaVault,
  NativeBiometricGate,
  WebBiometricGate,
  detectPlatform,
  type BiometricAvailability,
  type BiometricGate,
  type BiometricGateConfig,
} from "@trustid/device-security";
import { reauthenticate } from "../reauth";
import {
  injectCapacitorSecurityBridges,
  isNativeCapacitorShell,
} from "./nativeBridges";

declare global {
  interface Window {
    TrustIdBiometricGate?: {
      getAvailability(): Promise<BiometricAvailability>;
      authenticate(options: {
        reason: string;
        allowDeviceCredential: boolean;
        strongOnly: boolean;
      }): Promise<{ ok: boolean; method: string }>;
    };
    TrustIdMediaVault?: ConstructorParameters<typeof MediaVault>[1];
    TrustIdAppLock?: ConstructorParameters<typeof AppLockController>[1];
    Capacitor?: { isNativePlatform?: () => boolean };
  }
}

/**
 * Web / PWA gate: Trust ID cloud session — not device passkeys.
 * App Locker / Media Locker on browser confirm against the signed-in registry identity.
 */
class SessionTrustGate implements BiometricGate {
  async getAvailability(): Promise<BiometricAvailability> {
    const platform = detectPlatform();
    return {
      platform,
      available: true,
      enrolled: true,
      strength: "strong",
      hardwareBoundKeys: false,
      appLockSupported: false,
      secureWipeSupported: false,
      notes: [
        "PWA uses your Trust ID cloud session — not a device passkey.",
        "Cross-app App Lock and hardware vault wipe require the TrustID Android APK.",
      ],
    };
  }

  async authenticate(
    _config: BiometricGateConfig,
  ): Promise<{ ok: true; method: string }> {
    const base = import.meta.env.VITE_API_URL ?? "/api";
    const res = await fetch(`${base}/auth/session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      throw new Error("Trust ID session expired — verify your face again");
    }
    return { ok: true, method: "trustid_cloud_session" };
  }
}

/** Optional passkey step-up when explicitly requested (Secure / reauth flows). */
export function createPasskeyGate(): BiometricGate {
  return new WebBiometricGate(() => reauthenticate());
}

export function createTier1Gate(): BiometricGate {
  injectCapacitorSecurityBridges();
  if (isNativeCapacitorShell() && window.TrustIdBiometricGate) {
    return new NativeBiometricGate(window.TrustIdBiometricGate);
  }
  // Web & PWA: cloud session, never device passkey for locker / vault gates
  return new SessionTrustGate();
}

let vaultSingleton: MediaVault | null = null;
let lockSingleton: AppLockController | null = null;
let gateSingleton: BiometricGate | null = null;

export function getTier1Gate(): BiometricGate {
  if (!gateSingleton) gateSingleton = createTier1Gate();
  return gateSingleton;
}

export function getMediaVault(): MediaVault {
  if (!vaultSingleton) {
    injectCapacitorSecurityBridges();
    vaultSingleton = new MediaVault(
      getTier1Gate(),
      isNativeCapacitorShell() ? window.TrustIdMediaVault : undefined,
    );
  }
  return vaultSingleton;
}

export function getAppLockController(): AppLockController {
  if (!lockSingleton) {
    injectCapacitorSecurityBridges();
    lockSingleton = new AppLockController(
      getTier1Gate(),
      isNativeCapacitorShell() ? window.TrustIdAppLock : undefined,
    );
  }
  return lockSingleton;
}

export async function probeTier1Capabilities(): Promise<BiometricAvailability> {
  return getTier1Gate().getAvailability();
}

export { detectPlatform, isNativeCapacitorShell };
