/**
 * Multi-frame enrollment aggregation unit tests (no fabricated FAR/FRR).
 */
import { describe, expect, it } from "vitest";
import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import { l2Normalize } from "../src/capture/biometric/face-align.js";
import {
  filterDuplicateEmbeddings,
  qualityWeightedMean,
} from "../src/capture/biometric/enrollment.js";
import { getPadDeploymentStatus, PAD_STATUS } from "../src/capture/biometric/pad.js";
import type { AIVectorPayload } from "../src/capture/biometric/types.js";

function payload(seed: number, confidence = 0.9): AIVectorPayload {
  const vector = l2Normalize(
    Array.from({ length: 512 }, (_, i) => Math.sin(seed + i * 0.02)),
  );
  return {
    modality: BIOMETRIC_MODALITIES.FACE,
    vector,
    modelName: "insightface_arcface_w600k_mbf_v1",
    modelVersion: 1,
    confidence,
  };
}

describe("multi-frame enrollment aggregation", () => {
  it("skips near-duplicate frames", () => {
    const a = payload(1);
    const near = {
      ...a,
      vector: l2Normalize(a.vector.map((x, i) => x + (i % 3 === 0 ? 1e-6 : 0))),
      confidence: 0.88,
    };
    const b = payload(5);
    const { unique, duplicatesSkipped } = filterDuplicateEmbeddings([a, near, b]);
    expect(duplicatesSkipped).toBeGreaterThanOrEqual(1);
    expect(unique.length).toBe(2);
  });

  it("quality-weighted mean favors higher confidence", () => {
    const low = payload(2, 0.56);
    const high = payload(2, 0.99);
    // Same identity base with tiny noise on low
    high.vector = l2Normalize(
      low.vector.map((x, i) => x + 0.05 * Math.sin(i)),
    );
    const mean = qualityWeightedMean([low, high])!;
    const distLow = 1 - mean.reduce((s, x, i) => s + x * low.vector[i]!, 0);
    const distHigh = 1 - mean.reduce((s, x, i) => s + x * high.vector[i]!, 0);
    expect(distHigh).toBeLessThanOrEqual(distLow + 1e-9);
  });

  it("rejects empty quality-weighted set", () => {
    expect(qualityWeightedMean([payload(1, 0.1)], 0.55)).toBeNull();
  });
});

describe("PAD status", () => {
  it("marks PAD incomplete and does not claim anti-spoof coverage", () => {
    expect(PAD_STATUS).toBe("INCOMPLETE");
    const s = getPadDeploymentStatus();
    expect(s.miniFasNet).toBe("NOT_PRESENT");
    expect(s.claimsForbidden).toContain("printed-photo attacks");
  });
});
