/**
 * Pure CPU cosine-distance for 1:1 face verification (no DB).
 * Cosine distance = 1 - cosine similarity. Lower is closer.
 */
export function calculateCosineDistance(vecA: number[], vecB: number[]): number {
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) return 1;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const a = vecA[i] ?? 0;
    const b = vecB[i] ?? 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 1;

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/** Cosine distance when both vectors are already L2-normalized (dot ? similarity). */
export function calculateCosineDistanceNormalized(
  vecA: number[] | Float32Array,
  vecB: number[] | Float32Array,
): number {
  const len = Math.min(vecA.length, vecB.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += (vecA[i] ?? 0) * (vecB[i] ?? 0);
  }
  return 1 - dot;
}
