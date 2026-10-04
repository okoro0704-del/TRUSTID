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
  MEDIAPIPE_FACE_LANDMARKER_ARTIFACT,
  MEDIAPIPE_TASKS_VISION_VERSION,
  ORT_WEB_VERSION,
} from "./model-manifest.js";

export const BIOMETRIC_ASSET_CACHE = "trustid-biometric-assets-v1";
const LEGACY_CACHE_PREFIXES = ["trustid-models-", "trustid-ort-"];

function key(id: string, version: string): string {
  return `/__trustid/biometric-assets/${id}/${version}`;
}

export const BIOMETRIC_ASSET_KEYS = {
  ortWasm: (version: string = ORT_WEB_VERSION) => key("ort-wasm-simd-threaded", version),
  mediapipeWasm: (variant: "simd" | "nosimd") =>
    key(`mediapipe-vision-${variant}`, MEDIAPIPE_TASKS_VISION_VERSION),
  faceLandmarker: () => key("face-landmarker", MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.sha256),
  arcface: () => key("arcface-w600k-mbf", ARCFACE_MBF_ARTIFACT.sha256),
} as const;

export function expectedBiometricAssetKeys(): string[] {
  return [
    BIOMETRIC_ASSET_KEYS.ortWasm(),
    BIOMETRIC_ASSET_KEYS.mediapipeWasm("simd"),
    BIOMETRIC_ASSET_KEYS.mediapipeWasm("nosimd"),
    BIOMETRIC_ASSET_KEYS.faceLandmarker(),
    BIOMETRIC_ASSET_KEYS.arcface(),
  ];
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
  } catch {
    /* ignore */
  }
}
