/**
 * Regression: ANN/database failure must never load the full biometric gallery.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MATCH_MODE,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import {
  decideAfterRerank,
  exactRerankCandidates,
} from "../src/modules/trust-id/ann-rerank.js";
import {
  __assertNoFullGalleryFallback,
  PgVectorMatcherService,
} from "../src/modules/trust-id/vector-matcher.js";
import { MATCH_SEMANTICS_DOC } from "../src/modules/trust-id/match-semantics.js";
import * as pgvector from "../src/lib/pgvector.js";
import { prisma } from "../src/db/client.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";

function unit512(seed: number) {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed + i * 0.01));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

describe("ann rerank", () => {
  it("does not accept nearest neighbor above threshold", () => {
    const probe = unit512(1);
    const far = unit512(99);
    const ranked = exactRerankCandidates(probe, [
      {
        embeddingId: "a",
        userId: "u",
        trustId: "t",
        annDistance: 0.9,
        vector: far,
      },
    ]);
    const decision = decideAfterRerank(ranked, 0.35);
    expect(decision.reason).toBe("no_match");
    expect(decision.accepted).toBeNull();
  });

  it("accepts best candidate only when under threshold", () => {
    const probe = unit512(1);
    const ranked = exactRerankCandidates(probe, [
      {
        embeddingId: "a",
        userId: "u",
        trustId: "t",
        annDistance: 0.01,
        vector: probe,
      },
    ]);
    const decision = decideAfterRerank(ranked, 0.35);
    expect(decision.reason).toBe("accept");
    expect(decision.accepted?.distance).toBeLessThanOrEqual(0.35);
  });
});

describe("no full-gallery fallback", () => {
  beforeEach(() => {
    __clearHotVectorCacheForTests();
  });

  it("service prototype has no matchInMemory", () => {
    expect(__assertNoFullGalleryFallback()).toBe(true);
  });

  it("documents fail-closed ANN semantics", () => {
    expect(MATCH_SEMANTICS_DOC.serviceUnavailableBehavior).toMatch(/Never load/);
    expect(MATCH_SEMANTICS_DOC.thresholdSemantics).toMatch(/Nearest neighbor alone/);
  });

  it("identifyOneToMany fails closed when pgvector disabled and gallery non-empty", async () => {
    vi.spyOn(pgvector, "isPgVectorEnabled").mockResolvedValue(false);
    const findManySpy = vi.spyOn(prisma.biometricEmbedding, "findMany");
    vi.spyOn(prisma.biometricEmbedding, "count").mockResolvedValue(42);

    const svc = new PgVectorMatcherService();
    const result = await svc.identifyOneToMany({
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: unit512(7),
        modelName: "insightface_arcface_w600k_mbf_v1",
        modelVersion: 1,
        confidence: 0.9,
      },
    });

    expect(result.matched).toBe(false);
    expect(result.mode).toBe(BIOMETRIC_MATCH_MODE.IDENTIFY_1_N);
    expect(result.errorCode).toBe(
      BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE,
    );
    expect(findManySpy).not.toHaveBeenCalled();
    findManySpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("identifyOneToMany returns NO_MATCH on empty gallery without findMany", async () => {
    vi.spyOn(pgvector, "isPgVectorEnabled").mockResolvedValue(false);
    const findManySpy = vi.spyOn(prisma.biometricEmbedding, "findMany");
    vi.spyOn(prisma.biometricEmbedding, "count").mockResolvedValue(0);

    const svc = new PgVectorMatcherService();
    const result = await svc.identifyOneToMany({
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: unit512(3),
        modelName: "insightface_arcface_w600k_mbf_v1",
        modelVersion: 1,
        confidence: 0.9,
      },
    });

    expect(result.errorCode).toBe(BIOMETRIC_ERROR_CODES.NO_MATCH);
    expect(findManySpy).not.toHaveBeenCalled();
    findManySpy.mockRestore();
    vi.restoreAllMocks();
  });
});
