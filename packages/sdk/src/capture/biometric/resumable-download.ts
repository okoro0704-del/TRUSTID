/**
 * Download a model artifact in ranges.
 * A single GET of w600k_mbf.onnx is closed early in production
 * (net::ERR_CONNECTION_CLOSED, HTTP 200) before Content-Length is satisfied.
 * Small Range responses complete, so the file is assembled from those.
 */

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const CHUNK_ATTEMPTS = 4;
const CHUNK_TIMEOUT_MS = 25_000;

type FetchLike = typeof fetch;

function totalFromContentRange(header: string | null): number | null {
  const match = header?.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function fetchRange(
  fetchImpl: FetchLike,
  url: string,
  start: number,
  end: number,
): Promise<{ bytes: Uint8Array; total: number | null; completeBody: boolean }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`Model range failed (${res.status}) at ${start}-${end}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && start === 0) {
        return { bytes, total: bytes.byteLength, completeBody: true };
      }
      const expected = end - start + 1;
      if (bytes.byteLength !== expected) {
        throw new Error(
          `Model range short at ${start}-${end}: ${bytes.byteLength}/${expected}`,
        );
      }
      return {
        bytes,
        total: totalFromContentRange(res.headers.get("content-range")),
        completeBody: false,
      };
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Model range failed at ${start}-${end}`);
}

export async function downloadModelBytes(
  url: string,
  fetchImpl: FetchLike = fetch,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Promise<ArrayBuffer> {
  const first = await fetchRange(fetchImpl, url, 0, chunkBytes - 1);
  if (first.completeBody) {
    return first.bytes.buffer.slice(
      first.bytes.byteOffset,
      first.bytes.byteOffset + first.bytes.byteLength,
    );
  }
  const total = first.total;
  if (!total) {
    throw new Error(`Model download missing total size for ${url}`);
  }
  const out = new Uint8Array(total);
  out.set(first.bytes, 0);
  let offset = first.bytes.byteLength;
  while (offset < total) {
    const end = Math.min(total - 1, offset + chunkBytes - 1);
    const next = await fetchRange(fetchImpl, url, offset, end);
    if (next.completeBody) {
      throw new Error(`Unexpected full body while resuming ${url} at ${offset}`);
    }
    out.set(next.bytes, offset);
    offset += next.bytes.byteLength;
  }
  return out.buffer;
}
