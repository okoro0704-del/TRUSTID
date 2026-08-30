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
import {
  HttpElfComEmergencyBridge,
  SovereignVault,
  type ElfComEmergencyBridge,
  type NativeDakBridge,
} from "@trustid/vault-sdk";
import { sovereignToTier1Policy, tier1ToSovereignPolicy } from "./plugins/app-lock/adapter.js";
import { TrustIdAppLock } from "./plugins/app-lock.js";
import { DeviceAppLockRegistry } from "./plugins/app-lock/registry.js";
import { TrustIdBiometricGate } from "./plugins/biometric-gate.js";
import { TrustIdMediaVault } from "./plugins/media-vault.js";
import { TrustIdSovereignVault } from "./plugins/sovereign-vault.js";
import {
  TrustIdSilentAuth,
  silentAuthBridge,
} from "./plugins/silent-auth/index.js";
import {
  pairSilentHardwareKey,
  runNativeSilentLogin,
} from "@trustid/device-security";

export function isNativeDeviceRuntime(): boolean {
  return Capacitor.isNativePlatform();
}

export async function silentNativeLogin(apiFetch: <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>) {
  return runNativeSilentLogin(silentAuthBridge, { fetch: apiFetch });
}

export async function pairSilentNativeKey(apiFetch: <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>) {
  return pairSilentHardwareKey(silentAuthBridge, { fetch: apiFetch });
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
    getPolicy: async () => {
      const sovereign = await TrustIdAppLock.getPolicy();
      return sovereignToTier1Policy(sovereign);
    },
    setPolicy: async (policy) => {
      const existing = await TrustIdAppLock.getPolicy();
      await TrustIdAppLock.setPolicy({
        policy: tier1ToSovereignPolicy(policy, existing),
      });
    },
    openAccessibilitySettings: () => TrustIdAppLock.openAccessibilitySettings(),
    openOverlayPermissionSettings: () => TrustIdAppLock.openOverlayPermissionSettings(),
    canDrawOverlays: () => TrustIdAppLock.canDrawOverlays(),
    isAccessibilityEnabled: () => TrustIdAppLock.isAccessibilityEnabled(),
    challengeNow: (packageId) => TrustIdAppLock.challengeNow({ packageId }),
    getInstalledApps: (options) => TrustIdAppLock.getInstalledApps(options),
    setLockedApps: (packages) => TrustIdAppLock.setLockedApps({ packages }),
    requestFamilyControlsAuth: () =>
      TrustIdAppLock.requestFamilyControlsAuth?.() ??
      Promise.resolve({ authorized: false, message: "unavailable" }),
  };
  return new AppLockController(gate, bridge);
}

export function createSovereignVault(
  gate: BiometricGate,
  opts?: { elfcom?: ElfComEmergencyBridge },
): SovereignVault {
  let nativeDak: NativeDakBridge | undefined;
  if (isNativeDeviceRuntime()) {
    nativeDak = {
      hardwareBacked: true,
      unlockDakAfterBiometric: async (input) => {
        const r = await TrustIdSovereignVault.unlockDak(input);
        return { sessionHandle: r.sessionHandle, duress: r.duress };
      },
      deriveCdk: (input) => TrustIdSovereignVault.deriveCdk(input),
      lockDak: () => TrustIdSovereignVault.lockDak(),
    };
  }
  return new SovereignVault({
    gate,
    nativeDak,
    elfcom: opts?.elfcom,
  });
}

export function createDeviceAppLockRegistry(storage?: Storage): DeviceAppLockRegistry {
  return new DeviceAppLockRegistry(storage);
}

export {
  TrustIdAppLock,
  TrustIdBiometricGate,
  TrustIdMediaVault,
  TrustIdSovereignVault,
  TrustIdSilentAuth,
  silentAuthBridge,
  SovereignVault,
  HttpElfComEmergencyBridge,
  DeviceAppLockRegistry,
};
