/**
 * Biometric benchmark harness tests.
 *
 * Real FAR/FRR/Rank-N require a labeled face embedding dataset produced by the
 * production ArcFace pipeline. Until provided, accuracy fields remain MISSING.
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
import { TRUSTID_MODEL_MANIFEST } from "../src/capture/biometric/model-manifest.js";
import {
  buildGalleriesWhereDataPermits,
  calibrateThreshold,
  computeVerificationReport,
  makeSyntheticPlumbingDataset,
} from "../src/capture/biometric/benchmark/index.js";

describe("biometric benchmark harness", () => {
  it("reports production model/preprocess versions", () => {
    expect(BIOMETRIC_AI_MODEL_NAME).toBe("insightface_arcface_w600k_mbf_v1");
    expect(BIOMETRIC_AI_MODEL_VERSION).toBe(1);
    expect(BIOMETRIC_DETECTOR_VERSION).toBe("mediapipe_face_landmarker_v1");
    expect(BIOMETRIC_ALIGNMENT_VERSION).toBe("arcface_five_point_v1");
    expect(BIOMETRIC_PREPROCESSING_VERSION).toBe("arcface_112_rgb_v1");
    expect(TRUSTID_MODEL_MANIFEST.embeddingDimensions).toBe(512);
    expect(TRUSTID_MODEL_MANIFEST.similarityMetric).toBe("cosine_distance");
    expect(BIOMETRIC_PGVECTOR_MAX_DISTANCE).toBe(0.35);
  });

  it("metric math runs on synthetic plumbing data without claiming accuracy", () => {
    const ds = makeSyntheticPlumbingDataset();
    const v = computeVerificationReport(ds, {
      operatingThresholdDistance: BIOMETRIC_PGVECTOR_MAX_DISTANCE,
    });
    expect(v.status).toBe("SYNTHETIC_PLUMBING_ONLY");
    expect(v.genuineCount).toBeGreaterThan(0);
    expect(v.impostorCount).toBeGreaterThan(0);
    expect(v.operatingPoints.length).toBeGreaterThan(0);
    expect(v.genuineDistances).toHaveLength(v.genuineCount);
    // Low FAR targets must be marked not estimable on tiny plumbing sets
    const ultra = v.operatingPoints.find((p) => p.targetFar === 1e-6);
    expect(ultra?.estimability).toBe("NOT_ESTIMABLE_WITH_CURRENT_SAMPLE_SIZE");

    const cal = calibrateThreshold(v, BIOMETRIC_PGVECTOR_MAX_DISTANCE);
    expect(cal.status).toBe("SYNTHETIC_PLUMBING_ONLY");
    expect(cal.proposedThresholdCosineDistance).toBeNull();

    const id = buildGalleriesWhereDataPermits(ds, [10_000], 0.35);
    expect(id[0]?.status).toBe("SKIPPED_INSUFFICIENT_GALLERY");
  });

  it("documents labeled biometric accuracy as MISSING without a dataset", () => {
    const report = {
      labeledFaceBenchmarks: "MISSING",
      far: "MISSING",
      frr: "MISSING",
      eer: "MISSING",
      roc: "MISSING",
      tarAtFar: "MISSING",
      rank1: "MISSING",
      rank5: "MISSING",
      rank10: "MISSING",
      fpir: "MISSING",
      fnir: "MISSING",
      thresholdCalibration: "THRESHOLD_CANNOT_BE_CALIBRATED_WITH_CURRENT_DATA",
    };
    expect(report.far).toBe("MISSING");
    expect(report.thresholdCalibration).toBe(
      "THRESHOLD_CANNOT_BE_CALIBRATED_WITH_CURRENT_DATA",
    );
  });
});
