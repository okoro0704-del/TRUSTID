/**
 * Keeps this device's Master Device key in IndexedDB. CryptoKey objects are stored as-is (structured
 * clone), so the non-extractable private key never exists as bytes in JavaScript or storage.
 * Clearing site data removes the key: the device must then be revoked and enrolled again.
 */
const DB_NAME = "trustid-master-device";
const STORE = "keys";
const RECORD = "current";

export type StoredDevice = {
  privateKey: CryptoKey;
  publicKeySpki: string;
  deviceFingerprint: string;
  trustId: string;
  enrolledAt: string;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDevice(): Promise<StoredDevice | null> {
  try {
    return ((await tx("readonly", (s) => s.get(RECORD))) as StoredDevice | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  await tx("readwrite", (s) => s.put(device, RECORD));
}

export async function forgetDevice(): Promise<void> {
  await tx("readwrite", (s) => s.delete(RECORD));
}
