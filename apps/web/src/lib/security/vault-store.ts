import type { EsfsChunkRecord, EsfsManifest } from "@trustid/vault-sdk";

const DB_NAME = "trustid-sovereign-vault";
const DB_VERSION = 1;
const MANIFEST_STORE = "manifests";
const CHUNK_STORE = "chunks";

type ChunkRow = {
  assetId: string;
  index: number;
  envelope: ArrayBuffer;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        db.createObjectStore(MANIFEST_STORE, { keyPath: "assetId" });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, {
          keyPath: ["assetId", "index"],
        });
        store.createIndex("byAsset", "assetId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function saveEsfsAsset(input: {
  manifest: EsfsManifest;
  chunks: EsfsChunkRecord[];
}): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MANIFEST_STORE, CHUNK_STORE], "readwrite");
  tx.objectStore(MANIFEST_STORE).put(input.manifest);
  const chunkStore = tx.objectStore(CHUNK_STORE);
  for (const chunk of input.chunks) {
    chunkStore.put({
      assetId: input.manifest.assetId,
      index: chunk.index,
      envelope: chunk.envelope.buffer.slice(
        chunk.envelope.byteOffset,
        chunk.envelope.byteOffset + chunk.envelope.byteLength,
      ) as ArrayBuffer,
    } satisfies ChunkRow);
  }
  await txDone(tx);
  db.close();
}

export async function loadAllEsfsAssets(): Promise<
  { manifest: EsfsManifest; chunks: EsfsChunkRecord[] }[]
> {
  const db = await openDb();
  const tx = db.transaction([MANIFEST_STORE, CHUNK_STORE], "readonly");
  const manifests = await new Promise<EsfsManifest[]>((resolve, reject) => {
    const req = tx.objectStore(MANIFEST_STORE).getAll();
    req.onsuccess = () => resolve(req.result as EsfsManifest[]);
    req.onerror = () => reject(req.error);
  });

  const assets: { manifest: EsfsManifest; chunks: EsfsChunkRecord[] }[] = [];
  for (const manifest of manifests) {
    const chunks = await new Promise<EsfsChunkRecord[]>((resolve, reject) => {
      const req = tx
        .objectStore(CHUNK_STORE)
        .index("byAsset")
        .getAll(IDBKeyRange.only(manifest.assetId));
      req.onsuccess = () => {
        const rows = req.result as ChunkRow[];
        resolve(
          rows.map((row) => ({
            index: row.index,
            envelope: new Uint8Array(row.envelope),
          })),
        );
      };
      req.onerror = () => reject(req.error);
    });
    assets.push({ manifest, chunks });
  }

  await txDone(tx);
  db.close();
  return assets;
}

export async function deleteEsfsAsset(assetId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MANIFEST_STORE, CHUNK_STORE], "readwrite");
  tx.objectStore(MANIFEST_STORE).delete(assetId);
  const chunkStore = tx.objectStore(CHUNK_STORE);
  const rows = await new Promise<ChunkRow[]>((resolve, reject) => {
    const req = chunkStore.index("byAsset").getAll(IDBKeyRange.only(assetId));
    req.onsuccess = () => resolve(req.result as ChunkRow[]);
    req.onerror = () => reject(req.error);
  });
  for (const row of rows) {
    chunkStore.delete([assetId, row.index]);
  }
  await txDone(tx);
  db.close();
}
