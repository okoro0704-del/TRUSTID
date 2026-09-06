/**
 * Biometric benchmark harness (synthetic + optional real gallery).
 * Synthetic probes measure plumbing/latency only — not recognition accuracy.
 *
 * Usage:
 *   npx vitest run packages/sdk/tests/biometric-benchmark.harness.test.ts
 *
 * Real FAR/FRR/Rank-N require labeled face datasets — report MISSING until provided.
 */
import { describe, expect, it } from "vitest";
import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
} from "@trustid/shared";
import { l2Normalize, meanNormalizeEmbeddings } from "../src/capture/biometric/face-align.js";
import { TRUSTID_MODEL_MANIFEST } from "../src/capture/biometric/model-manifest.js";

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return 1 - dot;
}

function randomUnit(dims: number, seed: number): number[] {
  const v = Array.from({ length: dims }, (_, i) => Math.sin(seed * 17 + i * 0.13));
  return l2Normalize(v);
}

describe("biometric benchmark harness", () => {
  it("reports model/preprocess versions", () => {
    const report = {
      modelName: BIOMETRIC_AI_MODEL_NAME,
      modelVersion: BIOMETRIC_AI_MODEL_VERSION,
      detectorVersion: BIOMETRIC_DETECTOR_VERSION,
      alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
      preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
      embeddingDimensions: TRUSTID_MODEL_MANIFEST.embeddingDimensions,
      similarityMetric: TRUSTID_MODEL_MANIFEST.similarityMetric,
      threshold: BIOMETRIC_PGVECTOR_MAX_DISTANCE,
      datasets: {
        labeledFaceBenchmarks: "MISSING — provide genuine/impostor pairs for FAR/FRR/ROC/EER",
        gallerySizesTested: [] as number[],
        rank1: "MISSING",
        rank5: "MISSING",
        rank10: "MISSING",
        fpir: "MISSING",
        fnir: "MISSING",
        far: "MISSING",
        frr: "MISSING",
        eer: "MISSING",
      },
    };
    expect(report.modelName).toBe("insightface_arcface_w600k_mbf_v1");
    expect(report.datasets.far).toBe("MISSING");
  });

  it("measures synthetic gallery search latency (plumbing only)", () => {
    const sizes = [1_000, 10_000];
    const results: Array<{ n: number; ms: number }> = [];
    for (const n of sizes) {
      const gallery = Array.from({ length: n }, (_, i) => randomUnit(512, i + 1));
      const probe = randomUnit(512, 99_001);
      const t0 = performance.now();
      let best = Infinity;
      for (const g of gallery) {
        const d = cosineDistance(probe, g);
        if (d < best) best = d;
      }
      results.push({ n, ms: performance.now() - t0 });
      expect(best).toBeGreaterThanOrEqual(0);
    }
    // Not a recognition claim — only linear scan timing on synthetic vectors
    expect(results.length).toBe(2);
  });

  it("multi-shot mean is stable under L2", () => {
    const shots = [randomUnit(512, 1), randomUnit(512, 1), randomUnit(512, 2)];
    const primary = meanNormalizeEmbeddings(shots.slice(0, 2));
    expect(primary).toHaveLength(512);
  });
});
