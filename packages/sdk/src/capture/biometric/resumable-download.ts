/**
 * Download a biometric asset in ranges.
 * A single GET of w600k_mbf.onnx is closed early in production
 * (net::ERR_CONNECTION_CLOSED, HTTP 200) before Content-Length is satisfied.
 * Small Range responses complete, so the file is assembled from those.
 *
 * Failures carry an explicit category so a missing file, an HTML page in
 * place of a binary, and a stalled connection are told apart. Bytes already
 * received survive a failed attempt, so a retry resumes instead of restarting.
 */

const DEFAULT_CHUNK_BYTES = 256 * 1024;
/** Adaptive bounds: a fast link earns larger ranges (fewer round trips), a slow one smaller. */
export const MIN_CHUNK_BYTES = 128 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** A range that finishes faster than this doubles the next one. */
const GROW_BELOW_MS = 2_000;
/** A range slower than this halves the next one, keeping ranges well under connection cut-offs. */
const SHRINK_ABOVE_MS = 10_000;
const CHUNK_ATTEMPTS = 4;
/** No bytes for this long means the connection is dead, not slow. */
export const DEFAULT_STALL_MS = 30_000;

export const BIOMETRIC_ASSET_ERROR = {
  MISSING: "ASSET_MISSING",
  NOT_BINARY: "ASSET_NOT_BINARY",
  HTTP: "ASSET_HTTP_ERROR",
  STALLED: "ASSET_STALLED",
  NETWORK: "ASSET_NETWORK_ERROR",
  INCOMPLETE: "ASSET_INCOMPLETE",
  INTEGRITY: "ASSET_INTEGRITY_MISMATCH",
} as const;

export type BiometricAssetErrorCategory =
  (typeof BIOMETRIC_ASSET_ERROR)[keyof typeof BIOMETRIC_ASSET_ERROR];

export class BiometricAssetError extends Error {
  readonly category: BiometricAssetErrorCategory;
  readonly url: string;
  readonly status?: number;

  constructor(
    category: BiometricAssetErrorCategory,
    url: string,
    detail: string,
    status?: number,
  ) {
    super(`${category}: ${detail} (${url})`);
    this.name = "BiometricAssetError";
    this.category = category;
    this.url = url;
    this.status = status;
  }
}

/** A missing file or an HTML page will not change on retry. */
function isPermanent(err: unknown): boolean {
  return (
    err instanceof BiometricAssetError &&
    (err.category === BIOMETRIC_ASSET_ERROR.MISSING ||
      err.category === BIOMETRIC_ASSET_ERROR.NOT_BINARY)
  );
}

type FetchLike = typeof fetch;

/**
 * Durable record of received ranges, so a reload or a closed tab resumes
 * instead of starting from zero. Integrity is still checked on the whole file.
 */
export type PartialRangeStore = {
  load(url: string): Promise<{ total: number; bytes: Uint8Array } | null>;
  append(url: string, start: number, bytes: Uint8Array, total: number): Promise<void>;
  clear(url: string): Promise<void>;
};

export type DownloadOptions = {
  stallMs?: number;
  onProgress?: (loaded: number, total: number | null) => void;
  /** Persist received ranges across page loads. */
  store?: PartialRangeStore;
  /** Grow/shrink the range size with measured throughput. */
  adaptive?: boolean;
  now?: () => number;
};

type PartialDownload = { total: number; out: Uint8Array; offset: number };
const partialDownloads = new Map<string, PartialDownload>();

function totalFromContentRange(header: string | null): number | null {
  const match = header?.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && i < 64 && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09 || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) {
    i += 1;
  }
  if (bytes[i] !== 0x3c) return false;
  const head = new TextDecoder().decode(bytes.subarray(i, i + 32)).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body");
}

function rejectAfter(ms: number, onTimeout: () => Error): {
  promise: Promise<never>;
  clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  promise.catch(() => undefined);
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * Read a body, failing only when no bytes arrive for `stallMs`. A slow chunk
 * that keeps delivering is never cut off.
 */
async function readBody(
  res: Response,
  url: string,
  stallMs: number,
  abort: () => void,
): Promise<Uint8Array> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    return new Uint8Array(await res.arrayBuffer());
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const stall = rejectAfter(
      stallMs,
      () => new BiometricAssetError(BIOMETRIC_ASSET_ERROR.STALLED, url, `no bytes for ${stallMs}ms`),
    );
    try {
      const { done, value } = await Promise.race([reader.read(), stall.promise]);
      if (done) break;
      if (value) {
        parts.push(value);
        size += value.byteLength;
      }
    } catch (err) {
      abort();
      void reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      stall.clear();
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function fetchRangeOnce(
  fetchImpl: FetchLike,
  url: string,
  start: number,
  end: number,
  stallMs: number,
): Promise<{ bytes: Uint8Array; total: number | null; completeBody: boolean }> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abort = () => controller?.abort();
  const headersStall = rejectAfter(stallMs, () => {
    abort();
    return new BiometricAssetError(BIOMETRIC_ASSET_ERROR.STALLED, url, `no response for ${stallMs}ms`);
  });
  let res: Response;
  try {
    res = await Promise.race([
      fetchImpl(url, {
        credentials: "same-origin",
        // Verified bytes are kept in Cache Storage. The HTTP cache must never
        // replay a stale or error response for a biometric asset.
        cache: "no-store",
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller?.signal,
      }),
      headersStall.promise,
    ]);
  } catch (err) {
    if (err instanceof BiometricAssetError) throw err;
    throw new BiometricAssetError(
      BIOMETRIC_ASSET_ERROR.NETWORK,
      url,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    headersStall.clear();
  }

  if (res.status === 404 || res.status === 410) {
    throw new BiometricAssetError(BIOMETRIC_ASSET_ERROR.MISSING, url, `HTTP ${res.status}`, res.status);
  }
  if (res.status !== 206 && res.status !== 200) {
    throw new BiometricAssetError(
      BIOMETRIC_ASSET_ERROR.HTTP,
      url,
      `HTTP ${res.status} at ${start}-${end}`,
      res.status,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(contentType)) {
    throw new BiometricAssetError(
      BIOMETRIC_ASSET_ERROR.NOT_BINARY,
      url,
      `served as ${contentType.split(";")[0]}`,
      res.status,
    );
  }
  const bytes = await readBody(res, url, stallMs, abort);
  if (start === 0 && looksLikeHtml(bytes)) {
    throw new BiometricAssetError(BIOMETRIC_ASSET_ERROR.NOT_BINARY, url, "body is an HTML page", res.status);
  }
  if (res.status === 200 && start === 0) {
    return { bytes, total: bytes.byteLength, completeBody: true };
  }
  const total = totalFromContentRange(res.headers.get("content-range"));
  // Servers clamp a range that runs past the end of the file.
  const lastByte = total != null ? Math.min(end, total - 1) : end;
  const expected = lastByte - start + 1;
  if (bytes.byteLength !== expected) {
    throw new BiometricAssetError(
      BIOMETRIC_ASSET_ERROR.INCOMPLETE,
      url,
      `range ${start}-${end} returned ${bytes.byteLength}/${expected}`,
    );
  }
  return { bytes, total, completeBody: false };
}

async function fetchRange(
  fetchImpl: FetchLike,
  url: string,
  start: number,
  end: number,
  stallMs: number,
): Promise<{ bytes: Uint8Array; total: number | null; completeBody: boolean }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
    try {
      return await fetchRangeOnce(fetchImpl, url, start, end, stallMs);
    } catch (err) {
      lastError = err;
      if (isPermanent(err)) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new BiometricAssetError(BIOMETRIC_ASSET_ERROR.NETWORK, url, `range ${start}-${end} failed`);
}

export function nextChunkBytes(current: number, elapsedMs: number): number {
  if (elapsedMs < GROW_BELOW_MS) return Math.min(MAX_CHUNK_BYTES, current * 2);
  if (elapsedMs > SHRINK_ABOVE_MS) return Math.max(MIN_CHUNK_BYTES, Math.floor(current / 2));
  return current;
}

async function restoreFromStore(
  url: string,
  store: PartialRangeStore | undefined,
): Promise<PartialDownload | null> {
  if (!store) return null;
  try {
    const saved = await store.load(url);
    if (!saved || saved.bytes.byteLength === 0 || saved.bytes.byteLength >= saved.total) return null;
    const out = new Uint8Array(saved.total);
    out.set(saved.bytes, 0);
    return { total: saved.total, out, offset: saved.bytes.byteLength };
  } catch {
    return null;
  }
}

/** Range writes run alongside the next fetch; `settle` waits for them before a clear. */
function rangeWriter(store: PartialRangeStore | undefined, url: string) {
  const pending = new Set<Promise<void>>();
  return {
    persist(start: number, bytes: Uint8Array, total: number): void {
      if (!store) return;
      // Best effort: a failed write only means a later reload re-downloads this range.
      const p = store.append(url, start, bytes, total).catch(() => undefined);
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    async clear(): Promise<void> {
      if (!store) return;
      await Promise.all(pending);
      await store.clear(url).catch(() => undefined);
    },
  };
}

export async function downloadModelBytes(
  url: string,
  fetchImpl: FetchLike = fetch,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  options: DownloadOptions = {},
): Promise<ArrayBuffer> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  let chunk = chunkBytes;
  const timedRange = async (start: number, end: number) => {
    const t0 = now();
    const r = await fetchRange(fetchImpl, url, start, end, stallMs);
    if (options.adaptive) chunk = nextChunkBytes(chunk, now() - t0);
    return r;
  };

  const writer = rangeWriter(options.store, url);
  let partial = partialDownloads.get(url) ?? (await restoreFromStore(url, options.store));
  if (partial) partialDownloads.set(url, partial);
  if (!partial) {
    const first = await timedRange(0, chunk - 1);
    if (first.completeBody) {
      options.onProgress?.(first.bytes.byteLength, first.bytes.byteLength);
      return bytesToArrayBuffer(first.bytes);
    }
    const total = first.total;
    if (!total) {
      throw new BiometricAssetError(BIOMETRIC_ASSET_ERROR.INCOMPLETE, url, "missing total size");
    }
    partial = { total, out: new Uint8Array(total), offset: 0 };
    partial.out.set(first.bytes, 0);
    partial.offset = first.bytes.byteLength;
    partialDownloads.set(url, partial);
    writer.persist(0, first.bytes, total);
  }
  options.onProgress?.(partial.offset, partial.total);
  while (partial.offset < partial.total) {
    const end = Math.min(partial.total - 1, partial.offset + chunk - 1);
    const next = await timedRange(partial.offset, end);
    if (next.completeBody) {
      partialDownloads.delete(url);
      await writer.clear();
      throw new BiometricAssetError(
        BIOMETRIC_ASSET_ERROR.INCOMPLETE,
        url,
        `server ignored Range while resuming at ${partial.offset}`,
      );
    }
    if (next.total != null && next.total !== partial.total) {
      // The file behind this URL changed size mid-download: start over.
      partialDownloads.delete(url);
      await writer.clear();
      throw new BiometricAssetError(
        BIOMETRIC_ASSET_ERROR.INCOMPLETE,
        url,
        `size changed from ${partial.total} to ${next.total} while resuming`,
      );
    }
    partial.out.set(next.bytes, partial.offset);
    writer.persist(partial.offset, next.bytes, partial.total);
    partial.offset += next.bytes.byteLength;
    options.onProgress?.(partial.offset, partial.total);
  }
  partialDownloads.delete(url);
  await writer.clear();
  return partial.out.buffer as ArrayBuffer;
}

/** Drop bytes kept for a URL whose assembled file failed verification. */
export function forgetPartialDownload(url: string): void {
  partialDownloads.delete(url);
}

/** Test helper: forget bytes kept from failed downloads. */
export function resetPartialDownloadsForTests(): void {
  partialDownloads.clear();
}
