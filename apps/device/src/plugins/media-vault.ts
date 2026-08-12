import { registerPlugin } from "@capacitor/core";
import type { VaultImportResult, VaultItemMeta } from "@trustid/device-security";

export type MediaVaultPlugin = {
  list(): Promise<{ items: VaultItemMeta[] }>;
  importMedia(options: {
    bytesBase64: string;
    mimeType: string;
    displayName: string;
    wipeSourceUri?: string;
  }): Promise<VaultImportResult>;
  decrypt(options: {
    id: string;
  }): Promise<{ bytesBase64: string; mimeType: string; displayName: string }>;
  remove(options: { id: string }): Promise<void>;
};

export const TrustIdMediaVault = registerPlugin<MediaVaultPlugin>(
  "TrustIdMediaVault",
);
