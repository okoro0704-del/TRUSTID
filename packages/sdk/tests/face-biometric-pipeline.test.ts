import { describe, expect, it } from "vitest";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_LEGACY_MODEL_NAMES,
} from "@trustid/shared";
import {
  alignFaceToArcFace112,
  estimateSimilarityTransform,
  l2Normalize,
  meanNormalizeEmbeddings,
} from "../src/capture/biometric/face-align.js";
import { assessFaceQuality } from "../src/capture/biometric/face-quality.js";
import {
  FailClosedPadDetector,
  DevBypassPadDetector,
} from "../src/capture/biometric/pad.js";
import { MediaPipeBlinkPadDetector } from "../src/capture/biometric/pad-blink.js";
import {
  buildFaceTemplateEnvelope,
  parseFaceTemplateEnvelope,
} from "../src/capture/biometric/enrollment.js";
import { TRUSTID_MODEL_MANIFEST } from "../src/capture/biometric/model-manifest.js";
import type { DetectedFace } from "../src/capture/biometric/types.js";

describe("ArcFace alignment", () => {
  it("estimates identity similarity transform for matching points", () => {
    const src = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    const [a, b] = estimateSimilarityTransform(src, src);
    expect(a).toBeCloseTo(1, 5);
    expect(Math.abs(b)).toBeLessThan(1e-6);
  });

  it("produces 112×112×3 NCHW tensor", () => {
    const rgba = new Uint8ClampedArray(200 * 200 * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 128;
      rgba[i + 1] = 100;
      rgba[i + 2] = 90;
      rgba[i + 3] = 255;
    }
    const imageData = { data: rgba, width: 200, height: 200 } as ImageData;
    const landmarks = {
      leftEye: { x: 70, y: 80 },
      rightEye: { x: 130, y: 80 },
      nose: { x: 100, y: 110 },
      leftMouth: { x: 80, y: 140 },
      rightMouth: { x: 120, y: 140 },
    };
    const tensor = alignFaceToArcFace112(imageData, landmarks);
    expect(tensor.length).toBe(1 * 3 * 112 * 112);
  });

  it("mean-normalizes ArcFace gallery without dimension projection", () => {
    const a = l2Normalize(Array.from({ length: 512 }, (_, i) => (i % 7) / 7));
    const b = l2Normalize(Array.from({ length: 512 }, (_, i) => ((i + 3) % 11) / 11));
    const m = meanNormalizeEmbeddings([a, b]);
    expect(m).toHaveLength(BIOMETRIC_AI_EMBEDDING_DIMS);
    const norm = Math.sqrt(m.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("quality + PAD separation", () => {
  it("rejects tiny faces", () => {
    const face: DetectedFace = {
      box: { xMin: 0, yMin: 0, width: 10, height: 10 },
      confidence: 0.9,
      landmarks: {
        leftEye: { x: 2, y: 3 },
        rightEye: { x: 8, y: 3 },
        nose: { x: 5, y: 5 },
        leftMouth: { x: 3, y: 8 },
        rightMouth: { x: 7, y: 8 },
      },
    };
    const rgba = new Uint8ClampedArray(64 * 64 * 4);
    const q = assessFaceQuality(
      { data: rgba, width: 64, height: 64 } as ImageData,
      face,
    );
    expect(q.reasons).toContain("face_too_small");
  });

  it("fail-closed PAD returns unavailable", async () => {
    const pad = new FailClosedPadDetector();
    const r = await pad.evaluate();
    expect(r.decision).toBe("unavailable");
  });

  it("dev bypass is explicitly marked", async () => {
    const pad = new DevBypassPadDetector();
    const r = await pad.evaluate();
    expect(r.decision).toBe("accept");
    expect(r.modelVersion).toContain("dev_bypass");
  });

  it("blink PAD rejects without history", async () => {
    const pad = new MediaPipeBlinkPadDetector();
    const r = await pad.evaluate();
    expect(r.decision).toBe("reject");
  });
});

describe("template envelope + legacy", () => {
  it("builds v1 envelope with production model name", () => {
    const vector = l2Normalize(Array.from({ length: 512 }, () => 0.01));
    const env = buildFaceTemplateEnvelope(
      {
        modality: "face",
        vector,
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: 1,
        confidence: 0.9,
      },
      [
        {
          modality: "face",
          vector,
          modelName: BIOMETRIC_AI_MODEL_NAME,
          modelVersion: 1,
          confidence: 0.9,
        },
      ],
    );
    expect(env.schema).toBe("trustid_face_template_v1");
    expect(env.modelName).toBe(TRUSTID_MODEL_MANIFEST.modelName);
    expect(env.primary).toHaveLength(512);
  });

  it("marks raw arrays as legacy", () => {
    const parsed = parseFaceTemplateEnvelope(JSON.stringify(new Array(512).fill(0.1)));
    expect("legacy" in parsed && parsed.legacy).toBe(true);
  });

  it("lists spatial models as legacy", () => {
    expect(BIOMETRIC_LEGACY_MODEL_NAMES).toContain("spatial_fallback_v1");
    expect(BIOMETRIC_LEGACY_MODEL_NAMES).toContain("mobile_facenet_v1");
  });

  it("exposes biometric error codes", () => {
    expect(BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE).toBeTruthy();
    expect(BIOMETRIC_ERROR_CODES.LIVENESS_FAILED).toBeTruthy();
    expect(BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY).toBeTruthy();
  });
});
