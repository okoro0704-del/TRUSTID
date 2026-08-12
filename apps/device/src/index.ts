import { Capacitor } from "@capacitor/core";
import {
  AppLockController,
  MediaVault,
  NativeBiometricGate,
  WebBiometricGate,
  type BiometricGate,
  type NativeAppLockBridge,
  type NativeVaultBridge,
} from "@trustid/device-security";
import { TrustIdAppLock } from "./plugins/app-lock.js";
import { TrustIdBiometricGate } from "./plugins/biometric-gate.js";
import { TrustIdMediaVault } from "./plugins/media-vault.js";

export function isNativeDeviceRuntime(): boolean {
  return Capacitor.isNativePlatform();
}

export function createBiometricGate(
  webUv: () => Promise<unknown>,
): BiometricGate {
  if (isNativeDeviceRuntime()) {
    return new NativeBiometricGate(TrustIdBiometricGate);
  }
  return new WebBiometricGate(webUv);
}

export function createMediaVault(gate: BiometricGate): MediaVault {
  if (!isNativeDeviceRuntime()) return new MediaVault(gate);
  const bridge: NativeVaultBridge = {
    list: async () => (await TrustIdMediaVault.list()).items,
    importMedia: (input) => TrustIdMediaVault.importMedia(input),
    decrypt: (id) => TrustIdMediaVault.decrypt({ id }),
    remove: (id) => TrustIdMediaVault.remove({ id }),
  };
  return new MediaVault(gate, bridge);
}

export function createAppLockController(gate: BiometricGate): AppLockController {
  if (!isNativeDeviceRuntime()) return new AppLockController(gate);
  const bridge: NativeAppLockBridge = {
    getPolicy: () => TrustIdAppLock.getPolicy(),
    setPolicy: (policy) => TrustIdAppLock.setPolicy({ policy }),
    openAccessibilitySettings: () => TrustIdAppLock.openAccessibilitySettings(),
    isAccessibilityEnabled: () => TrustIdAppLock.isAccessibilityEnabled(),
    challengeNow: (packageId) => TrustIdAppLock.challengeNow({ packageId }),
  };
  return new AppLockController(gate, bridge);
}

export {
  TrustIdAppLock,
  TrustIdBiometricGate,
  TrustIdMediaVault,
};
