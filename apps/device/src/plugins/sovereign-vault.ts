import { registerPlugin } from "@capacitor/core";
import type { EsfsManifest } from "@trustid/vault-sdk";

/**
 * Native sovereign vault bridge — Keystore/Keychain DAK + eSFS chunk IO.
 *
 * Android: `SovereignVaultPlugin.kt` should:
 * - Generate DAK in Android Keystore (StrongBox when available), user-auth required.
 * - Derive per-chunk CDK via HKDF inside TEE after BiometricPrompt success.
 * - Store eSFS blobs under `context.noBackupFilesDir/trustid/esfs/`.
 *
 * iOS: `SovereignVaultPlugin.swift` should:
 * - DAK in Secure Enclave via Keychain `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`.
 * - CDK derivation with CryptoKit HKDF after LAContext.evaluatePolicy.
 */
export type SovereignVaultPlugin = {
  unlockDak(options: {
    reason: string;
    strongOnly?: boolean;
    allowDeviceCredential?: boolean;
  }): Promise<{ sessionHandle: string; hardwareBacked: boolean; duress?: boolean }>;
  lockDak(): Promise<void>;
  deriveCdk(options: {
    sessionHandle: string;
    assetId: string;
    chunkIndex: number;
  }): Promise<{ cdkBase64: string }>;
  encryptChunk(options: {
    sessionHandle: string;
    assetId: string;
    chunkIndex: number;
    plaintextBase64: string;
  }): Promise<{ envelopeBase64: string }>;
  decryptChunk(options: {
    sessionHandle: string;
    assetId: string;
    chunkIndex: number;
    envelopeBase64: string;
  }): Promise<{ plaintextBase64: string }>;
  writeManifest(options: { manifest: EsfsManifest }): Promise<void>;
  readManifest(options: { assetId: string }): Promise<{ manifest: EsfsManifest | null }>;
  dispatchDuressAlert(options: {
    correlationId: string;
    elfcomBaseUrl: string;
    nodeSecret: string;
  }): Promise<{ ok: boolean }>;
};

export const TrustIdSovereignVault = registerPlugin<SovereignVaultPlugin>(
  "TrustIdSovereignVault",
);
