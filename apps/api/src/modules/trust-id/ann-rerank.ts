/**
 * Exact cosine reranking over a bounded ANN candidate set.
 * Used only after Top-K retrieval — never over the full gallery.
 */

export type AnnCandidate = {
  embeddingId: string;
  userId: string;
  trustId: string;
  /** Approximate distance from ANN (pgvector); may be refined */
  annDistance: number;
  /** Optional exact embedding for rerank; when absent, annDistance is used */
  vector?: number[];
};

export type RerankResult = {
  embeddingId: string;
  userId: string;
  trustId: string;
  distance: number;
  similarity: number;
  rank: number;
};

export function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return 1 - dot;
}

/**
 * Rerank candidates by exact cosine distance when vectors are present;
 * otherwise sort by ANN distance. Returns ascending distance order.
 */
export function exactRerankCandidates(
  probe: number[],
  candidates: AnnCandidate[],
): RerankResult[] {
  const scored = candidates.map((c) => {
    const distance =
      c.vector && c.vector.length === probe.length
        ? cosineDistance(probe, c.vector)
        : c.annDistance;
    return {
      embeddingId: c.embeddingId,
      userId: c.userId,
      trustId: c.trustId,
      distance,
      similarity: 1 - distance,
      rank: 0,
    };
  });
  scored.sort((a, b) => a.distance - b.distance);
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

/**
 * Decision: best candidate after rerank must be under threshold.
 * Nearest alone is never enough without threshold check.
 */
export function decideAfterRerank(
  ranked: RerankResult[],
  thresholdDistance: number,
): { accepted: RerankResult | null; reason: "accept" | "no_match" | "empty" } {
  if (!ranked.length) return { accepted: null, reason: "empty" };
  const best = ranked[0]!;
  if (best.distance <= thresholdDistance) {
    return { accepted: best, reason: "accept" };
  }
  return { accepted: null, reason: "no_match" };
}
