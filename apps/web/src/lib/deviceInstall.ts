const LS_KEY = "trustid.device.installId";
const OCC_KEY = "trustid.device.occupancy";
const IDB_NAME = "trustid-device";
const IDB_STORE = "kv";
const IDB_INSTALL = "installId";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function idbGet(key: string): Promise<string | null> {
  if (!idbAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(IDB_STORE, "readonly");
          const get = tx.objectStore(IDB_STORE).get(key);
          get.onsuccess = () => {
            const v = get.result;
            resolve(typeof v === "string" ? v : null);
            db.close();
          };
          get.onerror = () => {
            resolve(null);
            db.close();
          };
        } catch {
          resolve(null);
          db.close();
        }
      };
    } catch {
      resolve(null);
    }
  });
}

function idbSet(key: string, value: string): Promise<void> {
  if (!idbAvailable()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(value, key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
        } catch {
          db.close();
          resolve();
        }
      };
    } catch {
      resolve();
    }
  });
}

/** Stable per-browser/app install UUID (IndexedDB + localStorage fallback). */
export async function getOrCreateInstallId(): Promise<string> {
  const fromIdb = await idbGet(IDB_INSTALL);
  if (fromIdb) {
    try {
      localStorage.setItem(LS_KEY, fromIdb);
    } catch {
      /* ignore */
    }
    return fromIdb;
  }
  try {
    const fromLs = localStorage.getItem(LS_KEY);
    if (fromLs) {
      await idbSet(IDB_INSTALL, fromLs);
      return fromLs;
    }
  } catch {
    /* ignore */
  }
  const next = uuid();
  await idbSet(IDB_INSTALL, next);
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}

export type LocalOccupancy = {
  trustId: string;
  boundAt: string;
};

export function getLocalOccupancy(): LocalOccupancy | null {
  try {
    const raw = localStorage.getItem(OCC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalOccupancy;
    if (!parsed?.trustId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function markLocalOccupancy(trustId: string) {
  try {
    const next: LocalOccupancy = {
      trustId,
      boundAt: new Date().toISOString(),
    };
    localStorage.setItem(OCC_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** Clear local “this phone has a TrustID” claim (does not rotate installId). */
export function clearLocalOccupancy() {
  try {
    localStorage.removeItem(OCC_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Full local reset after wipe / Unknown credential — keeps installId so server
 * reclaim still maps this phone, but unlocks Create TrustID UX.
 */
export function resetPhoneTrustBinding() {
  clearLocalOccupancy();
  try {
    localStorage.removeItem("trustid.rememberedAccount");
  } catch {
    /* ignore */
  }
}
