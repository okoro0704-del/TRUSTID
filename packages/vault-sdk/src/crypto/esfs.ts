import type { EsfsManifest } from "../types.js";
import { aesGcmDecrypt, aesGcmEncrypt, sha256Hex } from "./aes-gcm.js";
import { DakSession } from "./dak.js";

export const ESFS_MAGIC = "ESFS1";
export const DEFAULT_CHUNK_SIZE = 256 * 1024;

export type EsfsChunkRecord = {
  index: number;
  envelope: Uint8Array;
};

/**
 * Encrypted Sovereign File System (eSFS) ù chunked AES-256-GCM at rest.
 * Plaintext exists only in memory during encrypt/decrypt; CDK derived per chunk after biometric.
 */
export class EncryptedSovereignFileSystem {
  private manifests = new Map<string, EsfsManifest>();
  private chunks = new Map<string, EsfsChunkRecord[]>();

  constructor(private readonly dakSession: DakSession) {}

  async encryptAsset(input: {
    assetId: string;
    mimeType: string;
    displayName: string;
    bytes: Uint8Array;
    chunkSize?: number;
  }): Promise<EsfsManifest> {
    if (!this.dakSession.isUnlocked) {
      throw new Error("eSFS: DAK session locked");
    }

    const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkCount = Math.max(1, Math.ceil(input.bytes.length / chunkSize));
    const records: EsfsChunkRecord[] = [];

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const slice = input.bytes.subarray(start, start + chunkSize);
      const cdk = await this.dakSession.deriveCdk(input.assetId, i);
      const aad = new TextEncoder().encode(`${ESFS_MAGIC}:${input.assetId}:${i}`);
      const envelope = await aesGcmEncrypt(cdk, slice, aad);
      records.push({ index: i, envelope });
    }

    const manifest: EsfsManifest = {
      version: 1,
      assetId: input.assetId,
      mimeType: input.mimeType,
      displayName: input.displayName,
      contentHash: await sha256Hex(input.bytes),
      chunkSize,
      chunkCount,
      createdAt: new Date().toISOString(),
    };

    this.manifests.set(input.assetId, manifest);
    this.chunks.set(input.assetId, records);
    return manifest;
  }

  async decryptAsset(assetId: string): Promise<Uint8Array> {
    if (!this.dakSession.isUnlocked) {
      throw new Error("eSFS: DAK session locked");
    }
    const manifest = this.manifests.get(assetId);
    const records = this.chunks.get(assetId);
    if (!manifest || !records) {
      throw new Error("eSFS: asset not found");
    }

    const parts: Uint8Array[] = [];
    for (const record of records.sort((a, b) => a.index - b.index)) {
      const cdk = await this.dakSession.deriveCdk(assetId, record.index);
      const aad = new TextEncoder().encode(`${ESFS_MAGIC}:${assetId}:${record.index}`);
      parts.push(await aesGcmDecrypt(cdk, record.envelope, aad));
    }

    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  async decryptChunkStream(
    assetId: string,
    onChunk: (index: number, plain: Uint8Array) => Promise<void> | void,
  ): Promise<void> {
    const records = this.chunks.get(assetId);
    if (!records) throw new Error("eSFS: asset not found");
    for (const record of records.sort((a, b) => a.index - b.index)) {
      const cdk = await this.dakSession.deriveCdk(assetId, record.index);
      const aad = new TextEncoder().encode(`${ESFS_MAGIC}:${assetId}:${record.index}`);
      const plain = await aesGcmDecrypt(cdk, record.envelope, aad);
      await onChunk(record.index, plain);
    }
  }

  getManifest(assetId: string): EsfsManifest | undefined {
    return this.manifests.get(assetId);
  }

  listManifests(): EsfsManifest[] {
    return [...this.manifests.values()];
  }

  exportAsset(assetId: string): { manifest: EsfsManifest; chunks: EsfsChunkRecord[] } | null {
    const manifest = this.manifests.get(assetId);
    const chunks = this.chunks.get(assetId);
    if (!manifest || !chunks) return null;
    return { manifest, chunks: chunks.map((c) => ({ ...c, envelope: c.envelope.slice() })) };
  }

  loadAsset(manifest: EsfsManifest, chunks: EsfsChunkRecord[]): void {
    this.manifests.set(manifest.assetId, manifest);
    this.chunks.set(
      manifest.assetId,
      chunks.map((c) => ({ index: c.index, envelope: c.envelope.slice() })),
    );
  }

  removeAsset(assetId: string): void {
    this.manifests.delete(assetId);
    this.chunks.delete(assetId);
  }

  /** Attempt decrypt without unlocked DAK ù must fail. */
  async decryptWithoutSession(assetId: string): Promise<never> {
    if (this.dakSession.isUnlocked) {
      throw new Error("Test helper: session must be locked");
    }
    throw new Error("eSFS: DAK session locked");
  }
}
