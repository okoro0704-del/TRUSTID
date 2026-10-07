// @vitest-environment node
/**
 * Biometric asset delivery: every source (cache, app bundle, network) yields
 * only bytes whose SHA-256 matches the pinned release, network transfers are
 * compressed and resumable, and failures keep their explicit categories.
 * Real WebCrypto, real gzip, real DecompressionStream.
 */
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureBiometricDelivery,
  loadBiometricAsset,
  resetBiometricDeliveryForTests,
} from "../src/capture/biometric/asset-delivery.js";
import { getAssetProgress, resetAssetProgressForTests } from "../src/capture/biometric/asset-progress.js";
import {
  BIOMETRIC_ASSET_CACHE,
  BIOMETRIC_PARTIAL_CACHE,
  biometricAssetCacheKey,
  cacheStoragePartialStore,
} from "../src/capture/biometric/biometric-asset-cache.js";
import {
  biometricAssetDir,
  biometricAssetPath,
  type BiometricReleaseAsset,
} from "../src/capture/biometric/model-manifest.js";
import {
  downloadModelBytes,
  nextChunkBytes,
  resetPartialDownloadsForTests,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
} from "../src/capture/biometric/resumable-download.js";

class FakeCache {
  readonly entries = new Map<string, Uint8Array>();
  private k(req: RequestInfo | URL) {
    return new URL(typeof req === "string" ? req : req instanceof URL ? req.href : req.url, "http://localhost").href;
  }
  async match(req: RequestInfo | URL) {
    const hit = this.entries.get(this.k(req));
    return hit ? new Response(hit.slice()) : undefined;
  }
  async put(req: RequestInfo | URL, res: Response) {
    this.entries.set(this.k(req), new Uint8Array(await res.arrayBuffer()));
  }
  async delete(req: RequestInfo | URL) {
    return this.entries.delete(this.k(req));
  }
  async keys() {
    return [...this.entries.keys()].map((k) => new Request(k));
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.stores.get(name);
    if (!c) {
      c = new FakeCache();
      this.stores.set(name, c);
    }
    return c;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

type Served = { body: Uint8Array; contentType?: string };

/** Static host with Range support, a request log and fault injection. */
function fakeHost(files: Map<string, Served>) {
  const log: Array<{ url: string; range: string | null }> = [];
  let failAfterRanges = Infinity;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const range = new Headers(init?.headers).get("range");
    log.push({ url, range });
    if (range && log.filter((l) => l.range).length > failAfterRanges) {
      throw new TypeError("net::ERR_CONNECTION_CLOSED");
    }
    const file = files.get(url);
    if (!file) return new Response("<!doctype html><html></html>", { status: 404, headers: { "content-type": "text/html" } });
    const type = file.contentType ?? "application/octet-stream";
    if (!range) return new Response(file.body.slice(), { status: 200, headers: { "content-type": type } });
    const [s, e] = range.replace("bytes=", "").split("-").map(Number) as [number, number];
    const end = Math.min(e, file.body.byteLength - 1);
    return new Response(file.body.slice(s, end + 1), {
      status: 206,
      headers: {
        "content-type": type,
        "content-range": `bytes ${s}-${end}/${file.body.byteLength}`,
      },
    });
  };
  return {
    fetchImpl,
    log,
    failAfter(n: number) {
      failAfterRanges = n;
    },
    heal() {
      failAfterRanges = Infinity;
    },
  };
}

function assetFor(bytes: Uint8Array, file = "w600k_mbf.onnx"): BiometricReleaseAsset {
  return {
    id: "arcface",
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    contentType: "application/octet-stream",
    component: "embedder",
    version: "test",
  };
}

/** Compressible, model-like bytes (repetitive structure plus noise). */
function modelBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const noise = randomBytes(size);
  for (let i = 0; i < size; i++) out[i] = i % 7 === 0 ? noise[i]! : (i * 31) & 0x3f;
  return out;
}

const ORIGIN = "https://trustid.example/";
const CDN = "https://cdn.example/trustid/";

let storage: FakeCacheStorage;
let realFetch: typeof fetch;

beforeEach(() => {
  storage = new FakeCacheStorage();
  (globalThis as { caches?: unknown }).caches = storage;
  realFetch = globalThis.fetch;
  resetBiometricDeliveryForTests();
  resetAssetProgressForTests();
  resetPartialDownloadsForTests();
  configureBiometricDelivery({ assetBaseUrls: [ORIGIN], nativeBridge: null });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { caches?: unknown }).caches;
});

function useHost(files: Map<string, Served>) {
  const host = fakeHost(files);
  globalThis.fetch = host.fetchImpl as typeof fetch;
  return host;
}

describe("network delivery", () => {
  it("transfers the gzip file in ranges, decodes it and accepts only the pinned bytes", async () => {
    const bytes = modelBytes(900_000);
    const gz = gzipSync(bytes, { level: 9 });
    const asset = assetFor(bytes);
    const host = useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gz }]]));

    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });

    expect(loaded.source).toBe("network");
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(gz.byteLength).toBeLessThan(bytes.byteLength * 0.6);
    // Every request is a Range request against the content-addressed .gz.bin URL.
    expect(host.log.every((l) => l.range && l.url.endsWith(`/${biometricAssetDir(asset)}/w600k_mbf.onnx.gz.bin`))).toBe(true);
    // Progress reports compressed bytes actually transferred.
    expect(getAssetProgress("arcface")).toMatchObject({ loaded: gz.byteLength, total: gz.byteLength, source: "network", phase: "ready" });
    // Verified bytes are cached; no partial ranges are left behind.
    const cached = (await storage.open(BIOMETRIC_ASSET_CACHE)).entries;
    expect([...cached.keys()].some((k) => k.endsWith(biometricAssetCacheKey("arcface")))).toBe(true);
    expect((await storage.open(BIOMETRIC_PARTIAL_CACHE)).entries.size).toBe(0);
  });

  it("the next load is served from the cache with no network request", async () => {
    const bytes = modelBytes(300_000);
    const asset = assetFor(bytes);
    const host = useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gzipSync(bytes) }]]));
    await loadBiometricAsset(asset, { progressId: "arcface" });
    const requests = host.log.length;
    resetPartialDownloadsForTests();

    const again = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(again.source).toBe("cache");
    expect(host.log.length).toBe(requests);
  });

  it("a cached copy that no longer matches its hash is dropped and downloaded again", async () => {
    const bytes = modelBytes(200_000);
    const asset = assetFor(bytes);
    const bucket = await storage.open(BIOMETRIC_ASSET_CACHE);
    await bucket.put(biometricAssetCacheKey("arcface"), new Response(new Uint8Array([1, 2, 3])));
    useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gzipSync(bytes) }]]));

    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(loaded.source).toBe("network");
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("bytes that do not match the pinned hash are rejected, never cached, and not resumed", async () => {
    const bytes = modelBytes(200_000);
    const asset = assetFor(bytes);
    const tampered = bytes.slice();
    tampered[1000] ^= 0xff;
    useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gzipSync(tampered) }]]));

    await expect(loadBiometricAsset(asset, { progressId: "arcface" })).rejects.toMatchObject({
      category: "ASSET_INTEGRITY_MISMATCH",
    });
    expect((await storage.open(BIOMETRIC_ASSET_CACHE)).entries.size).toBe(0);
    expect((await storage.open(BIOMETRIC_PARTIAL_CACHE)).entries.size).toBe(0);
  });

  it("an HTML page in place of the asset is ASSET_NOT_BINARY, not an integrity or match failure", async () => {
    const bytes = modelBytes(10_000);
    const asset = assetFor(bytes);
    useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: new TextEncoder().encode("<!doctype html><html><body>app</body></html>"), contentType: "application/octet-stream" }]]));
    await expect(loadBiometricAsset(asset, { progressId: "arcface" })).rejects.toMatchObject({ category: "ASSET_NOT_BINARY" });
  });

  it("a CDN that fails falls back to the TrustID origin", async () => {
    const bytes = modelBytes(120_000);
    const asset = assetFor(bytes);
    configureBiometricDelivery({ assetBaseUrls: [CDN, ORIGIN] });
    const host = useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gzipSync(bytes) }]]));

    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(loaded.url.startsWith(ORIGIN)).toBe(true);
    expect(host.log[0]!.url.startsWith(CDN)).toBe(true);
  });

  it("a dropped connection resumes from the persisted ranges after a page reload", async () => {
    // Incompressible, so the file needs more ranges than the fault allows.
    const bytes = new Uint8Array(randomBytes(3_000_000));
    const gz = gzipSync(bytes, { level: 1 });
    const asset = assetFor(bytes);
    const url = `${ORIGIN}${biometricAssetPath(asset, true)}`;
    const host = useHost(new Map([[url, { body: gz }]]));
    host.failAfter(3);

    await expect(loadBiometricAsset(asset, { progressId: "arcface" })).rejects.toBeTruthy();
    const saved = await cacheStoragePartialStore.load(url);
    expect(saved?.bytes.byteLength).toBeGreaterThan(0);

    // "Reload": in-memory state is gone; only Cache Storage survives.
    resetPartialDownloadsForTests();
    host.heal();
    const before = host.log.length;
    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
    const firstResumed = host.log[before]!.range!;
    expect(Number(firstResumed.replace("bytes=", "").split("-")[0])).toBe(saved!.bytes.byteLength);
    expect((await storage.open(BIOMETRIC_PARTIAL_CACHE)).entries.size).toBe(0);
  });
});

describe("app bundle delivery (installed Android/iOS app)", () => {
  const BUNDLE = "https://trustid.example/__trustid_native__/";

  it("serves pinned assets from the installed app with no network download", async () => {
    const bytes = modelBytes(400_000);
    const asset = assetFor(bytes);
    configureBiometricDelivery({
      nativeBridge: {
        getBundle: async () => ({ apiVersion: 1, baseUrl: BUNDLE, assets: [biometricAssetDir(asset)] }),
      },
    });
    const host = useHost(new Map([[`${BUNDLE}${biometricAssetPath(asset)}`, { body: bytes }]]));

    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(loaded.source).toBe("app-bundle");
    expect(host.log.map((l) => l.url)).toEqual([`${BUNDLE}${biometricAssetPath(asset)}`]);
    expect(host.log.some((l) => l.url.startsWith(ORIGIN + "biometric"))).toBe(false);
    // The bundle already is local storage: nothing is duplicated into Cache Storage.
    expect((await storage.open(BIOMETRIC_ASSET_CACHE)).entries.size).toBe(0);
    expect(getAssetProgress("arcface")).toMatchObject({ source: "app-bundle", loaded: 0, phase: "ready" });
  });

  it("a damaged bundled file is never used; the network delivers the pinned bytes", async () => {
    const bytes = modelBytes(150_000);
    const asset = assetFor(bytes);
    const damaged = bytes.slice();
    damaged[10] ^= 1;
    configureBiometricDelivery({
      nativeBridge: {
        getBundle: async () => ({ apiVersion: 1, baseUrl: BUNDLE, assets: [biometricAssetDir(asset)] }),
      },
    });
    useHost(
      new Map([
        [`${BUNDLE}${biometricAssetPath(asset)}`, { body: damaged }],
        [`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gzipSync(bytes) }],
      ]),
    );
    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(loaded.source).toBe("network");
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a bundle from another release is not consulted", async () => {
    const bytes = modelBytes(50_000);
    const asset = assetFor(bytes);
    configureBiometricDelivery({
      nativeBridge: { getBundle: async () => ({ apiVersion: 1, baseUrl: BUNDLE, assets: ["0000000000000000"] }) },
    });
    const host = useHost(new Map([[`${ORIGIN}${biometricAssetPath(asset, true)}`, { body: gzipSync(bytes) }]]));
    const loaded = await loadBiometricAsset(asset, { progressId: "arcface" });
    expect(loaded.source).toBe("network");
    expect(host.log.some((l) => l.url.startsWith(BUNDLE))).toBe(false);
  });
});

describe("adaptive ranges", () => {
  it("grow on a fast link and shrink on a slow one, within bounds", () => {
    expect(nextChunkBytes(256 * 1024, 500)).toBe(512 * 1024);
    expect(nextChunkBytes(MAX_CHUNK_BYTES, 10)).toBe(MAX_CHUNK_BYTES);
    expect(nextChunkBytes(512 * 1024, 15_000)).toBe(256 * 1024);
    expect(nextChunkBytes(MIN_CHUNK_BYTES, 60_000)).toBe(MIN_CHUNK_BYTES);
    expect(nextChunkBytes(512 * 1024, 5_000)).toBe(512 * 1024);
  });

  it("a fast transfer needs far fewer requests than fixed 256 KiB ranges", async () => {
    const body = modelBytes(8 * 1024 * 1024);
    const url = "https://trustid.example/biometric/aaaaaaaaaaaaaaaa/x.bin.gz.bin";
    const host = fakeHost(new Map([[url, { body }]]));
    let t = 0;
    const out = new Uint8Array(
      await downloadModelBytes(url, host.fetchImpl as typeof fetch, 256 * 1024, {
        adaptive: true,
        now: () => (t += 100),
      }),
    );
    expect(Buffer.from(out).equals(Buffer.from(body))).toBe(true);
    expect(host.log.length).toBeLessThan(8 * 4 / 2);
  });

  it("a file whose size changes while resuming starts over instead of mixing versions", async () => {
    const url = "https://trustid.example/biometric/bbbbbbbbbbbbbbbb/y.bin.gz.bin";
    const a = modelBytes(600_000);
    const files = new Map([[url, { body: a }]]);
    const host = fakeHost(files);
    host.failAfter(1);
    await expect(downloadModelBytes(url, host.fetchImpl as typeof fetch, 256 * 1024)).rejects.toBeTruthy();
    host.heal();
    files.set(url, { body: modelBytes(700_000) });
    await expect(downloadModelBytes(url, host.fetchImpl as typeof fetch, 256 * 1024)).rejects.toMatchObject({
      category: "ASSET_INCOMPLETE",
    });
  });
});
