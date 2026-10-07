/**
 * One Cache Storage bucket for every downloaded biometric asset.
 *
 * Range downloads are not reused by the HTTP cache, so verified bytes are kept
 * here. Entries are keyed by asset id plus the version or SHA-256 the current
 * build expects, and anything else is pruned. A new build therefore never
 * reads a runtime binary or model that belongs to a different release, and
 * unchanged assets are not downloaded again.
 *
 * Callers still validate every cached read (magic bytes or SHA-256).
 */
import {
  ARCFACE_MBF_ARTIFACT,
  BIOMETRIC_RELEASE_ASSETS,
  biometricAssetDir,
  MEDIAPIPE_FACE_LANDMARKER_ARTIFACT,
  type BiometricReleaseAssetId,
} from "./model-manifest.js";
import type { PartialRangeStore } from "./resumable-download.js";

export const BIOMETRIC_ASSET_CACHE = "trustid-biometric-assets-v1";
/** Ranges of downloads that have not finished yet, so a reload resumes them. */
export const BIOMETRIC_PARTIAL_CACHE = "trustid-biometric-partial-v1";
const LEGACY_CACHE_PREFIXES = ["trustid-models-", "trustid-ort-"];

function key(id: string, version: string): string {
  return `/__trustid/biometric-assets/${id}/${version}`;
}

/** Every key is bound to the SHA-256 of the bytes it may hold. */
export const BIOMETRIC_ASSET_KEYS = {
  ortWasm: () => key("ort-wasm-simd-threaded", BIOMETRIC_RELEASE_ASSETS["ort-wasm"].sha256),
  mediapipeWasm: (variant: "simd" | "nosimd") =>
    key(
      `mediapipe-vision-${variant}`,
      BIOMETRIC_RELEASE_ASSETS[variant === "simd" ? "mediapipe-wasm-simd" : "mediapipe-wasm-nosimd"].sha256,
    ),
  faceLandmarker: () => key("face-landmarker", MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.sha256),
  arcface: () => key("arcface-w600k-mbf", ARCFACE_MBF_ARTIFACT.sha256),
} as const;

export function biometricAssetCacheKey(id: BiometricReleaseAssetId): string {
  switch (id) {
    case "ort-wasm":
      return BIOMETRIC_ASSET_KEYS.ortWasm();
    case "mediapipe-wasm-simd":
      return BIOMETRIC_ASSET_KEYS.mediapipeWasm("simd");
    case "mediapipe-wasm-nosimd":
      return BIOMETRIC_ASSET_KEYS.mediapipeWasm("nosimd");
    case "face-landmarker":
      return BIOMETRIC_ASSET_KEYS.faceLandmarker();
    case "arcface":
      return BIOMETRIC_ASSET_KEYS.arcface();
    default:
      return key(id, BIOMETRIC_RELEASE_ASSETS[id].sha256);
  }
}

export function expectedBiometricAssetKeys(): string[] {
  return (Object.keys(BIOMETRIC_RELEASE_ASSETS) as BiometricReleaseAssetId[]).map(biometricAssetCacheKey);
}

/** Content directories (sha256 prefixes) of the current release. */
function currentAssetDirs(): Set<string> {
  return new Set(Object.values(BIOMETRIC_RELEASE_ASSETS).map((a) => biometricAssetDir(a)));
}

function hasCaches(): boolean {
  return typeof caches !== "undefined";
}

export async function readBiometricAsset(cacheKey: string): Promise<Uint8Array | null> {
  try {
    if (!hasCaches()) return null;
    const hit = await (await caches.open(BIOMETRIC_ASSET_CACHE)).match(cacheKey);
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function storeBiometricAsset(
  cacheKey: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<void> {
  try {
    if (!hasCaches()) return;
    await (await caches.open(BIOMETRIC_ASSET_CACHE)).put(
      cacheKey,
      new Response(bytes.slice(0), { headers: { "Content-Type": contentType } }),
    );
  } catch {
    /* storage blocked or full: the next load downloads again */
  }
}

export async function dropBiometricAsset(cacheKey: string): Promise<void> {
  try {
    if (!hasCaches()) return;
    await (await caches.open(BIOMETRIC_ASSET_CACHE)).delete(cacheKey);
  } catch {
    /* ignore */
  }
}

function partialKey(url: string, start: number, total: number): string {
  return `/__trustid/partial${new URL(url, "http://x").pathname}?start=${start}&total=${total}`;
}

/**
 * Received ranges in Cache Storage, one entry per range. Only a contiguous
 * run from byte 0 with one consistent total is ever restored.
 */
export const cacheStoragePartialStore: PartialRangeStore = {
  async load(url) {
    if (!hasCaches()) return null;
    const cache = await caches.open(BIOMETRIC_PARTIAL_CACHE);
    const path = `/__trustid/partial${new URL(url, "http://x").pathname}`;
    const ranges: Array<{ start: number; total: number; req: Request }> = [];
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (u.pathname !== path) continue;
      const start = Number(u.searchParams.get("start"));
      const total = Number(u.searchParams.get("total"));
      if (Number.isFinite(start) && Number.isFinite(total) && total > 0) ranges.push({ start, total, req });
    }
    if (ranges.length === 0) return null;
    ranges.sort((a, b) => a.start - b.start);
    const total = ranges[0]!.total;
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const r of ranges) {
      if (r.total !== total || r.start !== offset) break;
      const hit = await cache.match(r.req);
      if (!hit) break;
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (bytes.byteLength === 0 || offset + bytes.byteLength > total) break;
      parts.push(bytes);
      offset += bytes.byteLength;
    }
    if (offset === 0) return null;
    const out = new Uint8Array(offset);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return { total, bytes: out };
  },
  async append(url, start, bytes, total) {
    if (!hasCaches()) return;
    const cache = await caches.open(BIOMETRIC_PARTIAL_CACHE);
    await cache.put(partialKey(url, start, total), new Response(bytes.slice(0)));
  },
  async clear(url) {
    if (!hasCaches()) return;
    const cache = await caches.open(BIOMETRIC_PARTIAL_CACHE);
    const path = `/__trustid/partial${new URL(url, "http://x").pathname}`;
    for (const req of await cache.keys()) {
      if (new URL(req.url).pathname === path) await cache.delete(req);
    }
  },
};

/** Delete entries from other builds and the caches older builds used. */
export async function pruneBiometricAssets(
  keep: string[] = expectedBiometricAssetKeys(),
): Promise<void> {
  try {
    if (!hasCaches()) return;
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => LEGACY_CACHE_PREFIXES.some((p) => n.startsWith(p)))
        .map((n) => caches.delete(n)),
    );
    const cache = await caches.open(BIOMETRIC_ASSET_CACHE);
    const wanted = new Set(keep.map((k) => new URL(k, "http://x").pathname));
    for (const req of await cache.keys()) {
      if (!wanted.has(new URL(req.url).pathname)) await cache.delete(req);
    }
    // Partial ranges are keyed by the asset's content directory; ranges of
    // another release can never complete into a file this build accepts.
    const dirs = currentAssetDirs();
    const partial = await caches.open(BIOMETRIC_PARTIAL_CACHE);
    for (const req of await partial.keys()) {
      const dir = new URL(req.url).pathname.match(/\/biometric\/([0-9a-f]{16})\//)?.[1];
      if (!dir || !dirs.has(dir)) await partial.delete(req);
    }
  } catch {
    /* ignore */
  }
}
