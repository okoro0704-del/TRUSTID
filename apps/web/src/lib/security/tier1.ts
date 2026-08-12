import {
  AppLockController,
  MediaVault,
  NativeBiometricGate,
  WebBiometricGate,
  detectPlatform,
  type BiometricAvailability,
  type BiometricGate,
} from "@trustid/device-security";
import { reauthenticate } from "../reauth";

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

function isNativeShell(): boolean {
  try {
    return window.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

export function createTier1Gate(): BiometricGate {
  if (isNativeShell() && window.TrustIdBiometricGate) {
    return new NativeBiometricGate(window.TrustIdBiometricGate);
  }
  return new WebBiometricGate(() => reauthenticate());
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
    vaultSingleton = new MediaVault(
      getTier1Gate(),
      isNativeShell() ? window.TrustIdMediaVault : undefined,
    );
  }
  return vaultSingleton;
}

export function getAppLockController(): AppLockController {
  if (!lockSingleton) {
    lockSingleton = new AppLockController(
      getTier1Gate(),
      isNativeShell() ? window.TrustIdAppLock : undefined,
    );
  }
  return lockSingleton;
}

export async function probeTier1Capabilities(): Promise<BiometricAvailability> {
  return getTier1Gate().getAvailability();
}

export { detectPlatform };
