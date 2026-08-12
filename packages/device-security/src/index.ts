export type {
  AppLockPolicy,
  BiometricAvailability,
  BiometricGateConfig,
  BiometricStrength,
  DecryptResult,
  LockedApp,
  SecurityPlatform,
  VaultImportResult,
  VaultItemMeta,
  VaultMediaKind,
} from "./types.js";
export { DEFAULT_APP_LOCK_POLICY } from "./types.js";

export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  bytesToBase64,
  exportVaultDek,
  generateVaultDek,
  importVaultDek,
  sha256Hex,
} from "./crypto/aes-gcm.js";

export {
  NativeBiometricGate,
  WebBiometricGate,
  detectPlatform,
  type BiometricGate,
} from "./biometric/gate.js";

export { MediaVault, type NativeVaultBridge } from "./vault/media-vault.js";
export {
  AppLockController,
  type NativeAppLockBridge,
} from "./applock/controller.js";
