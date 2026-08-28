import type { AppLockPolicy } from "@trustid/device-security";
import {
  DEFAULT_APP_LOCK_CONFIG,
  type AppLockConfig,
} from "@trustid/vault-sdk";

/** Map sovereign vault registry config to Tier 1 AppLockController policy. */
export function sovereignToTier1Policy(config: AppLockConfig): AppLockPolicy {
  return {
    enabled: config.enabled,
    allowDeviceCredential: config.allowDeviceCredential,
    biometricStrongOnly: config.biometricStrongOnly,
    postAuthGraceMs: config.postAuthGraceMs,
    lockOnBackground: true,
    apps: config.protectedApps.map((app) => ({
      packageId: app.packageId ?? app.appId,
      displayName: app.displayName,
      addedAt: app.addedAt,
    })),
  };
}

/** Merge Tier 1 policy edits into sovereign config, preserving vault-only fields. */
export function tier1ToSovereignPolicy(
  policy: AppLockPolicy,
  existing?: AppLockConfig,
): AppLockConfig {
  const base = existing ?? { ...DEFAULT_APP_LOCK_CONFIG };
  const protectedApps = policy.apps.map((app) => ({
    appId: app.packageId,
    packageId: app.packageId,
    displayName: app.displayName,
    addedAt: app.addedAt,
    hidden: base.hiddenAppShortcuts.includes(app.packageId),
  }));
  return {
    ...base,
    enabled: policy.enabled,
    allowDeviceCredential: policy.allowDeviceCredential,
    biometricStrongOnly: policy.biometricStrongOnly,
    postAuthGraceMs: policy.postAuthGraceMs,
    protectedAppIds: policy.apps.map((a) => a.packageId),
    protectedApps,
  };
}
