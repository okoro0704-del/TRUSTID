import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  bytesToBase64,
  generateVaultDek,
  sha256Hex,
} from "../crypto/aes-gcm.js";
import type { BiometricGate } from "../biometric/gate.js";
import type {
  DecryptResult,
  VaultImportResult,
  VaultItemMeta,
  VaultMediaKind,
} from "../types.js";

const DB_NAME = "trustid-media-vault";
const DB_VERSION = 1;
const STORE_META = "meta";
const STORE_BLOB = "blobs";
const STORE_KEYS = "keys";

function kindFromMime(mime: string): VaultMediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BLOB)) {
        db.createObjectStore(STORE_BLOB);
      }
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export type NativeVaultBridge = {
  list(): Promise<VaultItemMeta[]>;
  importMedia(input: {
    bytesBase64: string;
    mimeType: string;
    displayName: string;
    wipeSourceUri?: string;
  }): Promise<VaultImportResult>;
  decrypt(id: string): Promise<{ bytesBase64: string; mimeType: string; displayName: string }>;
  remove(id: string): Promise<void>;
};

/**
 * Local encrypted media vault.
 * - Web: AES-GCM + IndexedDB; DEK held in memory only after biometric gate.
 * - Native: delegates to Keystore-backed plugin.
 */
export class MediaVault {
  private dek: CryptoKey | null = null;
  private sessionUnlocked = false;

  constructor(
    private readonly gate: BiometricGate,
    private readonly native?: NativeVaultBridge,
  ) {}

  get isUnlocked(): boolean {
    return this.sessionUnlocked;
  }

  async unlock(reason = "Unlock TrustID Media Vault"): Promise<void> {
    await this.gate.authenticate({
      reason,
      allowDeviceCredential: false,
      strongOnly: true,
    });
    if (!this.native && !this.dek) {
      this.dek = await this.loadOrCreateWebDek();
    }
    this.sessionUnlocked = true;
  }

  lock(): void {
    this.dek = null;
    this.sessionUnlocked = false;
  }

  async list(): Promise<VaultItemMeta[]> {
    await this.requireUnlocked();
    if (this.native) return this.native.list();
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_META, "readonly");
      const all = await idbReq(tx.objectStore(STORE_META).getAll());
      return (all as VaultItemMeta[]).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    } finally {
      db.close();
    }
  }

  async importFile(
    file: File,
    opts?: { wipeSourceUri?: string },
  ): Promise<VaultImportResult> {
    await this.requireUnlocked();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (this.native) {
      return this.native.importMedia({
        bytesBase64: bytesToBase64(bytes),
        mimeType: file.type || "application/octet-stream",
        displayName: file.name || "media",
        wipeSourceUri: opts?.wipeSourceUri,
      });
    }

    const dek = this.dek!;
    const contentHash = await sha256Hex(bytes);
    const id = crypto.randomUUID();
    const aad = new TextEncoder().encode(`trustid-vault:${id}`);
    const envelope = await aesGcmEncrypt(dek, bytes, aad);
    const item: VaultItemMeta = {
      id,
      kind: kindFromMime(file.type || "application/octet-stream"),
      mimeType: file.type || "application/octet-stream",
      byteLength: bytes.length,
      contentHash,
      createdAt: new Date().toISOString(),
      displayName: file.name || "media",
    };

    const db = await openDb();
    try {
      const tx = db.transaction([STORE_META, STORE_BLOB], "readwrite");
      tx.objectStore(STORE_META).put(item);
      tx.objectStore(STORE_BLOB).put(bytesToBase64(envelope), id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("vault write failed"));
      });
    } finally {
      db.close();
    }

    // Zeroize plaintext buffer best-effort
    bytes.fill(0);

    return {
      item,
      sourceWiped: false,
      wipeNote:
        "Browser cannot erase system gallery originals. Delete the source in Photos/Files after import, or use TrustID Device for MediaStore wipe.",
    };
  }

  async decrypt(id: string): Promise<DecryptResult> {
    await this.requireUnlocked();
    if (this.native) {
      const r = await this.native.decrypt(id);
      return {
        bytes: base64ToBytes(r.bytesBase64),
        mimeType: r.mimeType,
        displayName: r.displayName,
      };
    }
    const db = await openDb();
    try {
      const tx = db.transaction([STORE_META, STORE_BLOB], "readonly");
      const meta = (await idbReq(
        tx.objectStore(STORE_META).get(id),
      )) as VaultItemMeta | undefined;
      const envelopeB64 = (await idbReq(
        tx.objectStore(STORE_BLOB).get(id),
      )) as string | undefined;
      if (!meta || !envelopeB64) throw new Error("Vault item not found");
      const aad = new TextEncoder().encode(`trustid-vault:${id}`);
      const plain = await aesGcmDecrypt(
        this.dek!,
        base64ToBytes(envelopeB64),
        aad,
      );
      return {
        bytes: plain,
        mimeType: meta.mimeType,
        displayName: meta.displayName,
      };
    } finally {
      db.close();
    }
  }

  async remove(id: string): Promise<void> {
    await this.requireUnlocked();
    if (this.native) {
      await this.native.remove(id);
      return;
    }
    const db = await openDb();
    try {
      const tx = db.transaction([STORE_META, STORE_BLOB], "readwrite");
      tx.objectStore(STORE_META).delete(id);
      tx.objectStore(STORE_BLOB).delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("vault delete failed"));
      });
    } finally {
      db.close();
    }
  }

  private async requireUnlocked(): Promise<void> {
    if (!this.sessionUnlocked) {
      throw new Error("Media vault is locked ù call unlock() after biometric gate");
    }
    if (!this.native && !this.dek) {
      throw new Error("Media vault DEK missing");
    }
  }

  private async loadOrCreateWebDek(): Promise<CryptoKey> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_KEYS, "readwrite");
      const existing = await idbReq(tx.objectStore(STORE_KEYS).get("web-dek"));
      if (existing) return existing as CryptoKey;

      const dek = await generateVaultDek();
      // Store non-extractable CryptoKey in IndexedDB (structured clone).
      // Gated by biometric unlock each session ó not enclave-bound on web.
      tx.objectStore(STORE_KEYS).put(dek, "web-dek");
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("dek persist failed"));
      });
      return dek;
    } finally {
      db.close();
    }
  }
}
