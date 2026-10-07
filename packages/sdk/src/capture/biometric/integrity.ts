/** SHA-256 integrity for model artifacts (Web Crypto). */

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return toHex(digest);
  }
  throw new Error("Web Crypto SHA-256 unavailable");
}

/** null when `bytes` hash to `expected`, otherwise the actual hash. */
export async function sha256Mismatch(bytes: Uint8Array, expected: string): Promise<string | null> {
  const view =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const actual = await sha256Hex(view);
  return actual.toLowerCase() === expected.toLowerCase() ? null : actual;
}

export async function fetchVerifiedArtifact(
  url: string,
  expectedSha256: string | null,
): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`Failed to fetch model artifact (${res.status}): ${url}`);
  }
  const buf = await res.arrayBuffer();
  if (expectedSha256 && !expectedSha256.startsWith("PLACEHOLDER")) {
    const actual = await sha256Hex(buf);
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Model integrity check failed for ${url}: expected ${expectedSha256}, got ${actual}`,
      );
    }
  }
  return buf;
}
