import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BiometricAssetError,
  downloadModelBytes,
  resetPartialDownloadsForTests,
} from "../src/capture/biometric/resumable-download.js";

beforeEach(() => resetPartialDownloadsForTests());

function rangeResponse(body: Uint8Array, start: number, total: number, status = 206) {
  return new Response(body, {
    status,
    headers: {
      "content-range": `bytes ${start}-${start + body.byteLength - 1}/${total}`,
      "content-length": String(body.byteLength),
    },
  });
}

describe("resumable model download", () => {
  it("assembles a file from ranges when a full GET would be closed early", async () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>).Range);
      const [start, end] = range.replace("bytes=", "").split("-").map(Number);
      return rangeResponse(payload.slice(start, end + 1), start, payload.byteLength);
    });
    const buffer = await downloadModelBytes("https://trustedid.example/w600k_mbf.onnx", fetchImpl as unknown as typeof fetch, 3);
    expect(new Uint8Array(buffer)).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a range after the connection closes", async () => {
    const payload = Uint8Array.from([9, 8, 7, 6]);
    let first = true;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>).Range);
      const [start, end] = range.replace("bytes=", "").split("-").map(Number);
      if (first && start === 0) {
        first = false;
        throw new TypeError("network error");
      }
      return rangeResponse(payload.slice(start, end + 1), start, payload.byteLength);
    });
    const buffer = await downloadModelBytes("https://trustedid.example/w600k_mbf.onnx", fetchImpl as unknown as typeof fetch, 2);
    expect(new Uint8Array(buffer)).toEqual(payload);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(2);
  });

  it("never lets the HTTP cache answer a biometric asset request", async () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.cache).toBe("no-store");
      return rangeResponse(payload, 0, payload.byteLength);
    });
    await downloadModelBytes("https://trustedid.example/a.onnx", fetchImpl as unknown as typeof fetch, 8);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 404 is ASSET_MISSING and is not retried", async () => {
    const fetchImpl = vi.fn(async () => new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } }));
    const err = await downloadModelBytes("https://trustedid.example/missing.onnx", fetchImpl as unknown as typeof fetch, 8).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BiometricAssetError);
    expect(err).toMatchObject({ category: "ASSET_MISSING", status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an HTML page served with HTTP 200 for an .onnx is ASSET_NOT_BINARY", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<!doctype html><html><body>app</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    await expect(
      downloadModelBytes("https://trustedid.example/w600k_mbf.onnx", fetchImpl as unknown as typeof fetch, 8),
    ).rejects.toMatchObject({ category: "ASSET_NOT_BINARY" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an HTML body behind a binary content type is still rejected", async () => {
    const html = new TextEncoder().encode("\n<!DOCTYPE html><html></html>");
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    await expect(
      downloadModelBytes("https://trustedid.example/w600k_mbf.onnx", fetchImpl as unknown as typeof fetch, 1024),
    ).rejects.toMatchObject({ category: "ASSET_NOT_BINARY" });
  });

  it("a connection that stops sending bytes is ASSET_STALLED after retries", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const err = await downloadModelBytes(
      "https://trustedid.example/w600k_mbf.onnx",
      fetchImpl as unknown as typeof fetch,
      8,
      { stallMs: 20 },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ category: "ASSET_STALLED" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("a slow chunk that keeps delivering bytes is not cut off", async () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const fetchImpl = vi.fn(async () => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 15));
          if (i >= payload.length) {
            controller.close();
            return;
          }
          controller.enqueue(payload.slice(i, i + 1));
          i += 1;
        },
      });
      return new Response(body, {
        status: 206,
        headers: { "content-range": `bytes 0-5/${payload.length}` },
      });
    });
    const buffer = await downloadModelBytes(
      "https://trustedid.example/w600k_mbf.onnx",
      fetchImpl as unknown as typeof fetch,
      6,
      { stallMs: 40 },
    );
    expect(new Uint8Array(buffer)).toEqual(payload);
  });

  it("a retry after a failed download resumes from the bytes already received", async () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    let failFrom: number | null = 4;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>).Range);
      const [start, end] = range.replace("bytes=", "").split("-").map(Number);
      starts.push(start!);
      if (failFrom !== null && start! >= failFrom) throw new TypeError("network error");
      return rangeResponse(payload.slice(start, end! + 1), start!, payload.byteLength);
    });
    const url = "https://trustedid.example/w600k_mbf.onnx";
    const progress: number[] = [];
    await expect(
      downloadModelBytes(url, fetchImpl as unknown as typeof fetch, 2),
    ).rejects.toMatchObject({ category: "ASSET_NETWORK_ERROR" });
    failFrom = null;
    starts.length = 0;
    const buffer = await downloadModelBytes(url, fetchImpl as unknown as typeof fetch, 2, {
      onProgress: (loaded) => progress.push(loaded),
    });
    expect(new Uint8Array(buffer)).toEqual(payload);
    expect(starts).toEqual([4, 6]);
    expect(progress[0]).toBe(4);
    expect(progress.at(-1)).toBe(8);
  });
});
