import { describe, expect, it } from "vitest";
import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  FACE_SCAN_REASON,
} from "@trustid/shared";
import {
  FACE_SCAN_STATE,
  runFaceScanLoop,
  type FaceScanDeps,
  type ScanFrame,
} from "../src/capture/biometric/face-scan-loop.js";
import type { DetectionResult } from "../src/capture/biometric/detector-mediapipe.js";
import type { FaceCandidate } from "../src/capture/biometric/pipeline.js";
import type {
  BiometricExtractError,
  BiometricExtractResult,
  DetectedFace,
} from "../src/capture/biometric/types.js";

const W = 48;
const H = 64;

function frame(id: number, luma = 120, width = W, height = H): ScanFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luma;
    data[i + 1] = luma;
    data[i + 2] = luma;
    data[i + 3] = 255;
  }
  return { imageData: { data, width, height } as unknown as ImageData, frameId: id };
}

const FACE: DetectedFace = {
  box: { xMin: 10, yMin: 10, width: 30, height: 40 },
  confidence: 0.9,
  landmarks: {
    leftEye: { x: 18, y: 22 },
    rightEye: { x: 30, y: 22 },
    nose: { x: 24, y: 30 },
    leftMouth: { x: 19, y: 38 },
    rightMouth: { x: 29, y: 38 },
  },
  landmarksInFrame: true,
};

function detection(faces: number): DetectionResult {
  return {
    faces: Array.from({ length: faces }, () => FACE),
    input: { width: H, height: H, ms: 5 },
  } as DetectionResult;
}

function candidate(score = 0.8): FaceCandidate {
  return { ok: true, face: FACE, quality: { ok: true, score, reasons: [] } };
}

function embedOk(confidence: number): BiometricExtractResult {
  return {
    ok: true,
    payload: {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: new Array(512).fill(0),
      modelName: BIOMETRIC_AI_MODEL_NAME,
      modelVersion: 1,
      confidence,
    },
    face: FACE,
    quality: { ok: true, score: confidence, reasons: [] },
    pad: { score: 1, decision: "accept", modelVersion: "t", reason: "t" },
  };
}

/** Deterministic clock: each frame/sleep advances virtual time. */
function harness(over: Partial<FaceScanDeps> & { frames?: (ScanFrame | null)[] }) {
  let t = 0;
  let id = 0;
  const frames = over.frames;
  const deps: FaceScanDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    nextFrame: async () => {
      t += 50;
      if (frames) return frames.length ? frames.shift()! : null;
      id += 1;
      return frame(id);
    },
    detect: async () => detection(1),
    evaluate: () => candidate(),
    embed: async () => embedOk(0.8),
    ...over,
  };
  return deps;
}

const OPTS = { budgetMs: 2_000, acceptConfidence: 0.55 };

describe("runFaceScanLoop", () => {
  it("completes on the first quality-accepted face and records portrait dimensions", async () => {
    const states: string[] = [];
    const out = await runFaceScanLoop(harness({ onState: (s) => states.push(s) }), OPTS);
    expect(out.ok).toBe(true);
    expect(out.diagnostics.counters.framesObserved).toBe(1);
    expect(out.diagnostics.counters.embeddingAttempts).toBe(1);
    expect(out.diagnostics.videoWidth).toBe(W);
    expect(out.diagnostics.videoHeight).toBe(H);
    expect(out.diagnostics.orientation).toBe("portrait");
    expect(out.diagnostics.inferenceMirrored).toBe(false);
    expect(states).toEqual([
      FACE_SCAN_STATE.WAITING_FOR_FRAME,
      FACE_SCAN_STATE.FRAME_READY,
      FACE_SCAN_STATE.DETECTING,
      FACE_SCAN_STATE.FACE_DETECTED,
      FACE_SCAN_STATE.QUALITY_ACCEPTED,
      FACE_SCAN_STATE.EMBEDDING,
      FACE_SCAN_STATE.COMPLETE,
    ]);
  });

  it("reports NO_FACE_DETECTED when the detector works but sees no face", async () => {
    const out = await runFaceScanLoop(harness({ detect: async () => detection(0) }), OPTS);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.NO_FACE_DETECTED);
    expect(out.code).toBe(BIOMETRIC_ERROR_CODES.NO_FACE);
    expect(out.diagnostics.counters.detectorSuccesses).toBeGreaterThan(0);
    expect(out.diagnostics.counters.embeddingAttempts).toBe(0);
  });

  it("reports MULTIPLE_FACES and never embeds an ambiguous frame", async () => {
    let embeds = 0;
    const out = await runFaceScanLoop(
      harness({
        detect: async () => detection(2),
        evaluate: (): BiometricExtractError => ({
          ok: false,
          code: BIOMETRIC_ERROR_CODES.MULTIPLE_FACES,
          reason: FACE_SCAN_REASON.MULTIPLE_FACES,
          message: "multi",
        }),
        embed: async () => {
          embeds += 1;
          return embedOk(0.9);
        },
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.MULTIPLE_FACES);
    expect(embeds).toBe(0);
  });

  it("recovers when low-quality frames are followed by a good frame", async () => {
    let n = 0;
    const out = await runFaceScanLoop(
      harness({
        evaluate: () => {
          n += 1;
          if (n < 3) {
            return {
              ok: false,
              code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
              reason: FACE_SCAN_REASON.EXCESSIVE_BLUR,
              message: "blur",
            };
          }
          return candidate();
        },
      }),
      OPTS,
    );
    expect(out.ok).toBe(true);
    expect(out.diagnostics.counters.qualityRejected).toBe(2);
    expect(out.diagnostics.counters.qualityAccepted).toBe(1);
  });

  it("names the dominant quality reason when no frame passes", async () => {
    const out = await runFaceScanLoop(
      harness({
        evaluate: () => ({
          ok: false,
          code: BIOMETRIC_ERROR_CODES.FACE_TOO_SMALL,
          reason: FACE_SCAN_REASON.FACE_TOO_SMALL,
          message: "small",
        }),
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.FACE_TOO_SMALL);
    expect(out.code).toBe(BIOMETRIC_ERROR_CODES.FACE_TOO_SMALL);
  });

  it("surfaces detector exceptions as DETECTOR_ERROR, not 'no face'", async () => {
    const out = await runFaceScanLoop(
      harness({
        detect: async () => {
          throw new TypeError("Failed to execute 'putImageData'");
        },
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.DETECTOR_ERROR);
    expect(out.code).toBe(BIOMETRIC_ERROR_CODES.DETECTOR_ERROR);
    expect(out.diagnostics.counters.detectorErrors).toBeGreaterThan(0);
    expect(out.diagnostics.counters.detectorSuccesses).toBe(0);
  });

  it("fails fast with MODEL_UNAVAILABLE when the detector model is missing", async () => {
    let calls = 0;
    const out = await runFaceScanLoop(
      harness({
        detect: async () => {
          calls += 1;
          throw new Error("MediaPipe face model unavailable");
        },
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE);
    expect(calls).toBe(1);
  });

  it("surfaces embedder exceptions as EMBEDDING_FAILED", async () => {
    const out = await runFaceScanLoop(
      harness({
        embed: async () => {
          throw new Error("ORT session run failed");
        },
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.EMBEDDING_FAILED);
    expect(out.code).toBe(BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED);
  });

  it("maps PAD rejection to LIVENESS_NOT_CONFIRMED without retry", async () => {
    let embeds = 0;
    const out = await runFaceScanLoop(
      harness({
        embed: async () => {
          embeds += 1;
          return { ok: false, code: BIOMETRIC_ERROR_CODES.LIVENESS_FAILED, message: "pad" };
        },
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.LIVENESS_NOT_CONFIRMED);
    expect(out.code).toBe(BIOMETRIC_ERROR_CODES.LIVENESS_FAILED);
    expect(embeds).toBe(1);
  });

  it("keeps the best below-threshold candidate and returns it at the budget", async () => {
    const confidences = [0.3, 0.5, 0.4];
    const out = await runFaceScanLoop(
      harness({ embed: async () => embedOk(confidences.shift() ?? 0.2) }),
      OPTS,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.confidence).toBe(0.5);
  });

  it("never resubmits a stale (unchanged) frame to the detector", async () => {
    let detects = 0;
    const out = await runFaceScanLoop(
      harness({
        nextFrame: async function () {
          return frame(7);
        },
        detect: async () => {
          detects += 1;
          return detection(0);
        },
        sleep: async () => undefined,
        now: (() => {
          let t = 0;
          return () => (t += 25);
        })(),
      }),
      OPTS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(detects).toBe(1);
    expect(out.diagnostics.counters.staleFrames).toBeGreaterThan(0);
  });

  it("never submits blank or dark frames to the detector", async () => {
    let detects = 0;
    const out = await runFaceScanLoop(
      harness({
        frames: [frame(1, 0), frame(2, 4), frame(3, 5), null],
        detect: async () => {
          detects += 1;
          return detection(1);
        },
      }),
      { ...OPTS, budgetMs: 400 },
    );
    expect(detects).toBe(0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.LOW_LIGHT);
    expect(out.diagnostics.counters.blankFrames).toBe(1);
    expect(out.diagnostics.counters.darkFrames).toBe(2);
  });

  it("reports NO_VIDEO_FRAME when the camera never delivers a frame", async () => {
    const out = await runFaceScanLoop(harness({ frames: [] }), { ...OPTS, budgetMs: 200 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.NO_VIDEO_FRAME);
  });

  it("returns SCAN_TIMEOUT when the budget elapses with no evidence at all", async () => {
    const out = await runFaceScanLoop(harness({}), { ...OPTS, budgetMs: 0 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.SCAN_TIMEOUT);
  });

  it("stops on abort and reports SCAN_ABORTED with the evidence reason", async () => {
    const controller = new AbortController();
    let detects = 0;
    const out = await runFaceScanLoop(
      harness({
        detect: async () => {
          detects += 1;
          if (detects === 2) controller.abort();
          return detection(0);
        },
      }),
      { ...OPTS, signal: controller.signal },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(FACE_SCAN_REASON.SCAN_ABORTED);
    expect(out.diagnostics.reason).toBe(FACE_SCAN_REASON.NO_FACE_DETECTED);
    expect(detects).toBe(2);
  });

  it("never runs detector or embedder calls concurrently", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const track = async <T>(v: T): Promise<T> => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight -= 1;
      return v;
    };
    const confidences = [0.2, 0.3, 0.4, 0.6];
    const out = await runFaceScanLoop(
      harness({
        detect: () => track(detection(1)),
        embed: () => track(embedOk(confidences.shift() ?? 0.6)),
      }),
      OPTS,
    );
    expect(out.ok).toBe(true);
    expect(maxInflight).toBe(1);
  });

  it("enforces the minimum detector cadence", async () => {
    const submitTimes: number[] = [];
    let t = 0;
    const deps = harness({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      nextFrame: async () => {
        t += 10;
        return frame(t);
      },
      detect: async () => {
        submitTimes.push(t);
        return detection(0);
      },
    });
    await runFaceScanLoop(deps, { ...OPTS, budgetMs: 1_000, minIntervalMs: 120 });
    for (let i = 1; i < submitTimes.length; i++) {
      expect(submitTimes[i]! - submitTimes[i - 1]!).toBeGreaterThanOrEqual(120);
    }
    expect(submitTimes.length).toBeGreaterThan(3);
  });

  it("zeroes every frame buffer after use", async () => {
    const seen: ScanFrame[] = [];
    let id = 0;
    await runFaceScanLoop(
      harness({
        nextFrame: async () => {
          id += 1;
          const f = frame(id);
          seen.push(f);
          return f;
        },
        detect: async () => detection(0),
      }),
      { ...OPTS, budgetMs: 300, minIntervalMs: 50 },
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) {
      expect(f.imageData.data.every((v) => v === 0)).toBe(true);
    }
  });
});
