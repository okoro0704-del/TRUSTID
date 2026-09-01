/** Derive a normalized embedding vector from arbitrary byte input. */
export function embeddingFromBytes(data: Uint8Array | string, dims = 16): number[] {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const v = Array.from({ length: dims }, (_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i; j < bytes.length; j += dims) {
      sum += bytes[j]!;
      count++;
    }
    return count > 0 ? sum / count / 255 : 0;
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}
