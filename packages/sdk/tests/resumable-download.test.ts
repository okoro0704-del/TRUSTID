import { describe, expect, it, vi } from "vitest";
import { downloadModelBytes } from "../src/capture/biometric/resumable-download.js";

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
});
