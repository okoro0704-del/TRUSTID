/** Platform capability matrix for Tier 1 consumer security. */
export type SecurityPlatform = "android" | "ios" | "web" | "desktop" | "unknown";

export type BiometricStrength = "strong" | "weak" | "device_credential" | "none";

export type BiometricGateConfig = {
  /** Prompt title shown by the OS biometric sheet. */
  reason: string;
  /**
   * When false (default), only Class-3 / strong biometrics.
   * PIN / pattern / password are refused unless the user opts in.
   */
  allowDeviceCredential?: boolean;
  /** Prefer BIOMETRIC_STRONG / biometryCurrentSet. */
  strongOnly?: boolean;
};

export type BiometricAvailability = {
  platform: SecurityPlatform;
  available: boolean;
  enrolled: boolean;
  strength: BiometricStrength;
  /** Hardware / enclave binding available for CryptoObject / Keychain. */
  hardwareBoundKeys: boolean;
  /** Cross-app process shield (Accessibility / launcher hook). */
  appLockSupported: boolean;
  /** Secure MediaStore / PhotoKit wipe of imported originals. */
  secureWipeSupported: boolean;
  notes: string[];
};

export type VaultMediaKind = "image" | "video" | "other";

export type VaultItemMeta = {
  id: string;
  kind: VaultMediaKind;
  mimeType: string;
  byteLength: number;
  contentHash: string;
  createdAt: string;
  /** Original filename for display only � never used as storage path. */
  displayName: string;
};

export type VaultImportResult = {
  item: VaultItemMeta;
  /** True when the platform scheduled / completed original removal. */
  sourceWiped: boolean;
  wipeNote?: string;
};

export type LockedApp = {
  /** Android package name or iOS bundle id. */
  packageId: string;
  displayName: string;
  addedAt: string;
};

export type AppLockPolicy = {
  enabled: boolean;
  allowDeviceCredential: boolean;
  biometricStrongOnly: boolean;
  /** Grace window after successful unlock before re-challenge (ms). */
  postAuthGraceMs: number;
  lockOnBackground: boolean;
  apps: LockedApp[];
};

export const DEFAULT_APP_LOCK_POLICY: AppLockPolicy = {
  enabled: false,
  allowDeviceCredential: false,
  biometricStrongOnly: true,
  postAuthGraceMs: 8_000,
  lockOnBackground: true,
  apps: [],
};

export type DecryptResult = {
  bytes: Uint8Array;
  mimeType: string;
  displayName: string;
};
