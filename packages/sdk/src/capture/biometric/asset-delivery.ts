/**
 * The one way the biometric engine obtains a binary.
 *
 * Every asset is named by the SHA-256 of its bytes (model-manifest.ts) and is
 * accepted only if it hashes to exactly that value, whatever its source:
 *
 *   1. Cache Storage    bytes verified on an earlier visit (warm web path)
 *   2. App bundle       the installed Android/iOS app ships the same files and
 *                       serves them locally (native path: no model download)
 *   3. Network          /biometric/<sha16>/<file>.gz.bin in resumable, adaptive
 *                       ranges, decoded locally; asset bases are tried in order
 *                       (e.g. a CDN, then the TrustID origin)
 *
 * Gzip files are fetched as plain binaries, so Range requests and compression
 * work together: a dropped connection resumes, and the transfer is the
 * compressed size rather than the 37.7 MiB of decoded runtimes and models.
 *
 * Diagnostics carry URLs, sizes, sources and categories only.
 */
import { reportAssetProgress, type BiometricAssetId, type BiometricAssetSource } from "./asset-progress.js";
import {
  biometricAssetCacheKey,
  cacheStoragePartialStore,
  dropBiometricAsset,
  readBiometricAsset,
  storeBiometricAsset,
} from "./biometric-asset-cache.js";
import { faceCaptureDiag, hashPrefix } from "./face-capture-diag.js";
import { sha256Mismatch } from "./integrity.js";
import {
  biometricAssetDir,
  biometricAssetPath,
  type BiometricReleaseAsset,
} from "./model-manifest.js";
import {
  BiometricAssetError,
  downloadModelBytes,
  forgetPartialDownload,
} from "./resumable-download.js";

/** Native shells implement this Capacitor plugin (TrustIdBiometricAssets). */
export type NativeBiometricAssetBridge = {
  getBundle(): Promise<{
    /** Contract version of the native asset API. */
    apiVersion: number;
    /**
     * Prefix that serves `biometric/<sha16>/<file>` from the installed app.
     * A path ("/__trustid_native__/") is resolved against the page origin.
     */
    baseUrl: string;
    /** Content directories (sha256 prefixes) shipped inside the app. */
    assets: string[];
    /**
     * Identity of this installation of the app (changes on every install or
     * update). Bundled files verified once for an installation are not
     * re-hashed on later launches of that same installation.
     */
    installId?: string;
  }>;
};

export type BiometricDeliveryConfig = {
  /**
   * Bases that serve `biometric/<sha16>/<file>[.gz.bin]`, tried in order. Default:
   * the page origin. A CDN may be listed first; it needs CORS for this origin.
   */
  assetBaseUrls?: string[];
  /** Override native bundle discovery (tests, or a host with its own bridge). */
  nativeBridge?: NativeBiometricAssetBridge | null;
};

type NativeBundle = { baseUrl: string; dirs: Set<string>; installId: string | null };

const NATIVE_ASSET_API_VERSION = 1;
const NATIVE_DISCOVERY_TIMEOUT_MS = 1_500;

let config: BiometricDeliveryConfig = {};
let nativeBundlePromise: Promise<NativeBundle | null> | null = null;

export function configureBiometricDelivery(next: BiometricDeliveryConfig): void {
  config = { ...config, ...next };
  if ("nativeBridge" in next) nativeBundlePromise = null;
}

function pageOrigin(): string {
  return typeof location !== "undefined" && location.origin && location.origin !== "null"
    ? location.origin
    : "http://localhost";
}

export function biometricAssetBases(): string[] {
  const bases = (config.assetBaseUrls ?? []).map((b) => b.trim()).filter(Boolean);
  const origin = `${pageOrigin()}/`;
  const normalized = bases.map((b) => (b.endsWith("/") ? b : `${b}/`));
  // The TrustID origin is always the last resort.
  if (!normalized.includes(origin)) normalized.push(origin);
  return normalized;
}

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
};

function discoverNativeBridge(): NativeBiometricAssetBridge | null {
  if ("nativeBridge" in config) return config.nativeBridge ?? null;
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const plugin = cap.Plugins?.TrustIdBiometricAssets as Partial<NativeBiometricAssetBridge> | undefined;
  return typeof plugin?.getBundle === "function" ? (plugin as NativeBiometricAssetBridge) : null;
}

/** The installed app's biometric bundle, or null on the web / older shells. */
export function getNativeBiometricBundle(): Promise<NativeBundle | null> {
  if (!nativeBundlePromise) {
    nativeBundlePromise = (async () => {
      const bridge = discoverNativeBridge();
      if (!bridge) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const info = await Promise.race([
          bridge.getBundle(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), NATIVE_DISCOVERY_TIMEOUT_MS);
          }),
        ]);
        if (!info || info.apiVersion < NATIVE_ASSET_API_VERSION || !info.baseUrl) return null;
        // A path-only base is served by the shell on the page's own origin.
        const absolute = info.baseUrl.startsWith("/") ? `${pageOrigin()}${info.baseUrl}` : info.baseUrl;
        const baseUrl = absolute.endsWith("/") ? absolute : `${absolute}/`;
        return { baseUrl, dirs: new Set(info.assets ?? []), installId: info.installId?.trim() || null };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  return nativeBundlePromise;
}

/**
 * Same-origin URLs that serve `asset` undecoded, best first: the installed
 * app's copy, then the content-addressed path on each asset base. For files
 * that must be loaded by URL (an ES module), where bytes cannot be handed over.
 */
export async function biometricAssetUrls(asset: BiometricReleaseAsset): Promise<string[]> {
  const urls: string[] = [];
  const bundle = await getNativeBiometricBundle();
  if (bundle?.dirs.has(biometricAssetDir(asset))) urls.push(`${bundle.baseUrl}${biometricAssetPath(asset)}`);
  for (const base of biometricAssetBases()) urls.push(`${base}${biometricAssetPath(asset)}`);
  return urls;
}

export function canDecodeGzip(): boolean {
  return typeof DecompressionStream !== "undefined" && typeof Response !== "undefined" && typeof Blob !== "undefined";
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && i < 64 && /\s/.test(String.fromCharCode(bytes[i]!))) i += 1;
  if (bytes[i] !== 0x3c) return false;
  const head = new TextDecoder().decode(bytes.subarray(i, i + 32)).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body");
}

export type LoadedBiometricAsset = {
  bytes: Uint8Array;
  source: BiometricAssetSource;
  url: string;
};

type Downloader = (
  url: string,
  onProgress: (loaded: number, total: number | null) => void,
) => Promise<ArrayBuffer>;

export type LoadBiometricAssetOptions = {
  /** Progress channel the readiness report reads. */
  progressId: BiometricAssetId;
  /** Replace the network transfer (tests and runtime hooks). */
  download?: Downloader;
};

const defaultDownload: Downloader = (url, onProgress) =>
  downloadModelBytes(url, fetch, undefined, {
    onProgress,
    store: cacheStoragePartialStore,
    adaptive: true,
  });

async function verify(asset: BiometricReleaseAsset, bytes: Uint8Array, url: string): Promise<void> {
  if (looksLikeHtml(bytes)) {
    throw new BiometricAssetError("ASSET_NOT_BINARY", url, "body is an HTML page");
  }
  const actual = await sha256Mismatch(bytes, asset.sha256);
  if (actual !== null) {
    throw new BiometricAssetError(
      "ASSET_INTEGRITY_MISMATCH",
      url,
      `${asset.file} expected ${hashPrefix(asset.sha256)} got ${hashPrefix(actual)}`,
    );
  }
}

async function fromCache(asset: BiometricReleaseAsset, progressId: BiometricAssetId): Promise<LoadedBiometricAsset | null> {
  const key = biometricAssetCacheKey(asset.id);
  const cached = await readBiometricAsset(key);
  if (!cached) return null;
  if ((await sha256Mismatch(cached, asset.sha256)) !== null) {
    await dropBiometricAsset(key);
    return null;
  }
  reportAssetProgress(progressId, {
    url: key,
    loaded: cached.byteLength,
    total: cached.byteLength,
    fromCache: true,
    source: "cache",
    phase: "ready",
  });
  return { bytes: cached, source: "cache", url: key };
}

const VERIFIED_KEY_PREFIX = "trustid-biometric-bundle-verified:";

function verifiedKey(installId: string, asset: BiometricReleaseAsset): string {
  return `${VERIFIED_KEY_PREFIX}${installId}:${asset.sha256}`;
}

function wasVerifiedForInstall(installId: string, asset: BiometricReleaseAsset): boolean {
  try {
    return globalThis.localStorage?.getItem(verifiedKey(installId, asset)) === "1";
  } catch {
    return false;
  }
}

function rememberVerifiedForInstall(installId: string, asset: BiometricReleaseAsset): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    // Forget verdicts of earlier installations.
    for (let i = store.length - 1; i >= 0; i--) {
      const k = store.key(i);
      if (k?.startsWith(VERIFIED_KEY_PREFIX) && !k.startsWith(`${VERIFIED_KEY_PREFIX}${installId}:`)) store.removeItem(k);
    }
    store.setItem(verifiedKey(installId, asset), "1");
  } catch {
    /* storage unavailable: the next launch verifies again */
  }
}

async function fromAppBundle(asset: BiometricReleaseAsset, progressId: BiometricAssetId): Promise<LoadedBiometricAsset | null> {
  const bundle = await getNativeBiometricBundle();
  if (!bundle || !bundle.dirs.has(biometricAssetDir(asset))) return null;
  const url = `${bundle.baseUrl}${biometricAssetPath(asset)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new BiometricAssetError("ASSET_MISSING", url, `HTTP ${res.status}`, res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    reportAssetProgress(progressId, { url, loaded: 0, total: 0, fromCache: true, source: "app-bundle", phase: "verifying" });
    if (bundle.installId && wasVerifiedForInstall(bundle.installId, asset) && bytes.byteLength === asset.bytes && !looksLikeHtml(bytes)) {
      // Already SHA-256-verified for this installation of the app. The OS
      // verified the signed package at install and the files are read-only
      // app assets; a new install or update changes installId and re-verifies.
    } else {
      await verify(asset, bytes, url);
      if (bundle.installId) rememberVerifiedForInstall(bundle.installId, asset);
    }
    reportAssetProgress(progressId, { url, loaded: 0, total: 0, fromCache: true, source: "app-bundle", phase: "ready" });
    return { bytes, source: "app-bundle", url };
  } catch (err) {
    // A damaged or missing bundled file must not block sign-in: the network
    // path below still delivers the same verified bytes.
    faceCaptureDiag({
      stage: "biometric_asset_bundle_failed",
      component: "delivery",
      success: false,
      modelUrl: url,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function fromNetwork(
  asset: BiometricReleaseAsset,
  options: LoadBiometricAssetOptions,
): Promise<LoadedBiometricAsset> {
  const download = options.download ?? defaultDownload;
  const gzip = canDecodeGzip();
  const bases = biometricAssetBases();
  let lastError: unknown;
  // A base that simply lacks the file must not hide a more telling failure
  // (wrong bytes, an HTML page, a stalled link) from another base.
  let telling: unknown = null;
  for (const base of bases) {
    const url = `${base}${biometricAssetPath(asset, gzip)}`;
    try {
      const report = (loaded: number, total: number | null, phase: "downloading" | "decoding" | "verifying" | "ready") =>
        reportAssetProgress(options.progressId, { url, loaded, total, fromCache: false, source: "network", phase });
      let transferred = 0;
      let transferTotal: number | null = null;
      const raw = new Uint8Array(
        await download(url, (loaded, total) => {
          transferred = loaded;
          transferTotal = total;
          report(loaded, total, "downloading");
        }),
      );
      transferred = Math.max(transferred, raw.byteLength);
      transferTotal ??= raw.byteLength;
      let bytes: Uint8Array = raw;
      if (isGzip(raw)) {
        report(transferred, transferTotal, "decoding");
        bytes = await gunzip(raw);
      }
      report(transferred, transferTotal, "verifying");
      try {
        await verify(asset, bytes, url);
      } catch (err) {
        // Never resume into a file that already failed verification.
        forgetPartialDownload(url);
        await cacheStoragePartialStore.clear(url).catch(() => undefined);
        throw err;
      }
      await storeBiometricAsset(biometricAssetCacheKey(asset.id), bytes, asset.contentType);
      report(transferred, transferTotal, "ready");
      return { bytes, source: "network", url };
    } catch (err) {
      lastError = err;
      faceCaptureDiag({
        stage: "biometric_asset_network_failed",
        component: "delivery",
        success: false,
        modelUrl: url,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      if (!(err instanceof BiometricAssetError && err.category === "ASSET_MISSING")) telling ??= err;
      // Any failure (missing, HTML, stalled, wrong bytes) moves on to the next base.
    }
  }
  throw telling ?? lastError;
}

/**
 * Bytes of `asset`, verified against its pinned SHA-256. Rejects with a
 * categorized BiometricAssetError (or an ASSET_INTEGRITY_MISMATCH error);
 * never resolves with unverified bytes.
 */
export async function loadBiometricAsset(
  asset: BiometricReleaseAsset,
  options: LoadBiometricAssetOptions,
): Promise<LoadedBiometricAsset> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const loaded =
    (await fromCache(asset, options.progressId)) ??
    (await fromAppBundle(asset, options.progressId)) ??
    (await fromNetwork(asset, options));
  faceCaptureDiag({
    stage: "biometric_asset_ready",
    component: "delivery",
    success: true,
    ms: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started),
    modelUrl: loaded.url,
    errorMessage: `source=${loaded.source} bytes=${loaded.bytes.byteLength}`,
  });
  return loaded;
}

/** Test helper. */
export function resetBiometricDeliveryForTests(): void {
  config = {};
  nativeBundlePromise = null;
}
