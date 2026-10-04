/**
 * Camera ? video ? frame readiness for the silent face scan. Detector,
 * embedder and model loading are mocked; camera/video/frame code is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  FACE_SCAN_REASON,
} from "@trustid/shared";

const models = vi.hoisted(() => ({
  ready: true,
  detect: null as null | ((img: ImageData) => Promise<unknown>),
}));

vi.mock("../src/capture/ai-vector-extractor.js", () => ({
  getSharedAIVectorExtractor: vi.fn(async () => ({
    isReady: () => models.ready,
    getLastError: () => (models.ready ? null : "ArcFace model unavailable"),
  })),
}));

vi.mock("../src/capture/biometric/detector-mediapipe.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    getFaceDetectorStatus: () => ({ state: models.ready ? "READY" : "FAILED", delegate: "CPU" }),
    detectFacesInImageData: vi.fn((img: ImageData) => models.detect!(img)),
  };
});

vi.mock("../src/capture/biometric/recognizer-arcface.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, getArcFaceEmbedderState: () => (models.ready ? "READY" : "FAILED") };
});

const FACE = {
  box: { xMin: 100, yMin: 150, width: 280, height: 340 },
  confidence: 0.9,
  landmarks: {
    leftEye: { x: 180, y: 260 },
    rightEye: { x: 300, y: 260 },
    nose: { x: 240, y: 330 },
    leftMouth: { x: 190, y: 410 },
    rightMouth: { x: 290, y: 410 },
  },
  landmarksInFrame: true,
};

vi.mock("../src/capture/biometric/pipeline.js", async () => {
  const { BIOMETRIC_AI_MODEL_NAME: modelName } = await import("@trustid/shared");
  return {
  evaluateFaceCandidate: () => ({
    ok: true,
    face: FACE,
    quality: { ok: true, score: 0.8, reasons: [] },
  }),
  embedFaceCandidate: async () => ({
    ok: true,
    payload: {
      modality: "face",
      vector: new Array(512).fill(0.01),
      modelName,
      modelVersion: 1,
      confidence: 0.8,
    },
    face: FACE,
    quality: { ok: true, score: 0.8, reasons: [] },
    pad: { score: 1, decision: "accept", modelVersion: "t", reason: "t" },
  }),
  };
});

import { captureSilentFaceFromWebCamera } from "../src/capture/silent-camera-web.js";

type FakeVideo = HTMLVideoElement & {
  setDims: (w: number, h: number, readyState: number) => void;
};

let drawCalls: unknown[][] = [];
let transforms: number[][] = [];
let videos: FakeVideo[] = [];

function installFakes() {
  drawCalls = [];
  transforms = [];
  videos = [];
  const origCreate = Document.prototype.createElement;
  vi.spyOn(document, "createElement").mockImplementation(function (
    this: Document,
    tag: string,
  ) {
    const el = origCreate.call(this, tag);
    if (tag === "video") {
      let w = 0;
      let h = 0;
      let rs = 0;
      Object.defineProperty(el, "videoWidth", { get: () => w, configurable: true });
      Object.defineProperty(el, "videoHeight", { get: () => h, configurable: true });
      Object.defineProperty(el, "readyState", { get: () => rs, configurable: true });
      (el as FakeVideo).setDims = (nw, nh, nrs) => {
        w = nw;
        h = nh;
        rs = nrs;
        el.dispatchEvent(new Event("loadedmetadata"));
      };
      (el as HTMLVideoElement).play = vi.fn().mockResolvedValue(undefined);
      videos.push(el as FakeVideo);
    }
    return el;
  } as typeof document.createElement);

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const canvas = this;
    return {
      setTransform: (...args: number[]) => transforms.push(args),
      drawImage: (...args: unknown[]) => drawCalls.push(args),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4).fill(128);
        return { data, width: w, height: h };
      },
      canvas,
    } as unknown as CanvasRenderingContext2D;
  } as never);
}

function fakeStream(stop = vi.fn(), trackState: MediaStreamTrackState = "live") {
  const track = { kind: "video", readyState: trackState, stop };
  return {
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    stop,
  };
}

async function untilVideo(): Promise<FakeVideo> {
  await vi.waitFor(() => expect(videos.length).toBeGreaterThan(0));
  return videos[videos.length - 1]!;
}

beforeEach(() => {
  models.ready = true;
  models.detect = async () => ({ faces: [FACE], input: { width: 640, height: 640, ms: 4 } });
  installFakes();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("silent face scan camera readiness", () => {
  it("waits for real video dimensions before reading frames, then completes", async () => {
    const { stream, stop } = fakeStream();
    const states: string[] = [];
    const pending = captureSilentFaceFromWebCamera(async () => stream, {
      onState: (s) => states.push(s),
      scanBudgetMs: 3_000,
    });
    const video = await untilVideo();
    await new Promise((r) => setTimeout(r, 50));
    // videoWidth is still 0: no VIDEO_READY, no frames grabbed.
    expect(states).not.toContain("VIDEO_READY");
    expect(drawCalls).toHaveLength(0);

    video.setDims(480, 640, 4);
    const result = await pending;

    expect(result?.errorCode).toBeUndefined();
    expect(result?.payload.vector).toHaveLength(512);
    expect(result?.payload.modelName).toBe(BIOMETRIC_AI_MODEL_NAME);
    expect(result?.payload.modality).toBe(BIOMETRIC_MODALITIES.FACE);
    expect(states.slice(0, 7)).toEqual([
      "REQUESTING_CAMERA",
      "CAMERA_GRANTED",
      "WAITING_FOR_VIDEO",
      "VIDEO_READY",
      "WAITING_FOR_FRAME",
      "FRAME_READY",
      "PREPARING_MODELS",
    ]);
    expect(states).toContain("DETECTING");
    expect(states).toContain("EMBEDDING");
    expect(states[states.length - 1]).toBe("COMPLETE");
    expect(stop).toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
  });

  it("waits for a decoded frame after metadata (readyState HAVE_METADATA)", async () => {
    const { stream } = fakeStream();
    const states: string[] = [];
    const pending = captureSilentFaceFromWebCamera(async () => stream, {
      onState: (s) => states.push(s),
      scanBudgetMs: 3_000,
    });
    const video = await untilVideo();
    video.setDims(480, 640, 1);
    await vi.waitFor(() => expect(states).toContain("WAITING_FOR_FRAME"));
    await new Promise((r) => setTimeout(r, 250));
    expect(states).not.toContain("FRAME_READY");
    expect(drawCalls).toHaveLength(0);

    video.setDims(480, 640, 4);
    const result = await pending;
    expect(result?.payload.vector).toHaveLength(512);
  });

  it("draws full portrait frames with an identity transform (never mirrored or cropped)", async () => {
    const { stream } = fakeStream();
    const pending = captureSilentFaceFromWebCamera(async () => stream, { scanBudgetMs: 3_000 });
    const video = await untilVideo();
    video.setDims(480, 640, 4);
    const result = await pending;

    expect(drawCalls.length).toBeGreaterThan(0);
    for (const call of drawCalls) {
      expect(call).toEqual([video, 0, 0, 480, 640]);
    }
    for (const t of transforms) expect(t).toEqual([1, 0, 0, 1, 0, 0]);
    expect(result?.diagnostics?.videoWidth).toBe(480);
    expect(result?.diagnostics?.videoHeight).toBe(640);
    expect(result?.diagnostics?.orientation).toBe("portrait");
    expect(result?.diagnostics?.inferenceMirrored).toBe(false);
    expect(result?.diagnostics?.frameSource).toBe("video-poll");
  });

  it("reports NO_VIDEO_FRAME (not 'no face') when metadata never arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { stream, stop } = fakeStream();
    const pending = captureSilentFaceFromWebCamera(async () => stream, { scanBudgetMs: 3_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await pending;
    expect(result?.reasonCode).toBe(FACE_SCAN_REASON.NO_VIDEO_FRAME);
    expect(result?.errorCode).toBe(BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE);
    expect(result?.payload.vector).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
  });

  it("reports CAMERA_UNAVAILABLE when permission is denied", async () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const result = await captureSilentFaceFromWebCamera(async () => {
      throw denied;
    });
    expect(result?.reasonCode).toBe(FACE_SCAN_REASON.CAMERA_UNAVAILABLE);
    expect(result?.errorCode).toBe(BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE);
  });

  it("rejects a granted stream whose video track is not live", async () => {
    const { stream, stop } = fakeStream(vi.fn(), "ended");
    const result = await captureSilentFaceFromWebCamera(async () => stream);
    expect(result?.reasonCode).toBe(FACE_SCAN_REASON.CAMERA_UNAVAILABLE);
    expect(stop).toHaveBeenCalled();
  });

  it("reports MODELS_NOT_READY when the detector/embedder are unavailable", async () => {
    models.ready = false;
    const { stream, stop } = fakeStream();
    const pending = captureSilentFaceFromWebCamera(async () => stream, { scanBudgetMs: 3_000 });
    const video = await untilVideo();
    video.setDims(480, 640, 4);
    const result = await pending;
    expect(result?.reasonCode).toBe(FACE_SCAN_REASON.MODELS_NOT_READY);
    expect(result?.errorCode).toBe(BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE);
    expect(result?.diagnostics?.detectorReady).toBe(false);
    expect(result?.diagnostics?.embedderReady).toBe(false);
    expect(stop).toHaveBeenCalled();
  });

  it("reports DETECTOR_ERROR and releases the camera when detection throws", async () => {
    models.detect = async () => {
      throw new TypeError("Failed to execute 'putImageData'");
    };
    const { stream, stop } = fakeStream();
    const pending = captureSilentFaceFromWebCamera(async () => stream, { scanBudgetMs: 600 });
    const video = await untilVideo();
    video.setDims(480, 640, 4);
    const result = await pending;
    expect(result?.reasonCode).toBe(FACE_SCAN_REASON.DETECTOR_ERROR);
    expect(result?.errorCode).toBe(BIOMETRIC_ERROR_CODES.DETECTOR_ERROR);
    expect(result?.payload.vector).toHaveLength(0);
    expect(result?.diagnostics?.counters.detectorErrors).toBeGreaterThan(0);
    expect(stop).toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
  });

  it("reports NO_FACE_DETECTED only when the detector actually ran", async () => {
    models.detect = async () => ({ faces: [], input: { width: 640, height: 640, ms: 4 } });
    const { stream } = fakeStream();
    const pending = captureSilentFaceFromWebCamera(async () => stream, { scanBudgetMs: 600 });
    const video = await untilVideo();
    video.setDims(480, 640, 4);
    const result = await pending;
    expect(result?.reasonCode).toBe(FACE_SCAN_REASON.NO_FACE_DETECTED);
    expect(result?.diagnostics?.counters.detectorSuccesses).toBeGreaterThan(0);
    expect(result?.diagnostics?.counters.framesSubmitted).toBeGreaterThan(0);
  });

  it("an overlapping scan stops the previous camera before opening a new one", async () => {
    const events: string[] = [];
    const first = fakeStream(vi.fn(() => events.push("stop-1")));
    const second = fakeStream(vi.fn(() => events.push("stop-2")));
    const scan1 = captureSilentFaceFromWebCamera(async () => {
      events.push("open-1");
      return first.stream;
    });
    await untilVideo();
    const scan2 = captureSilentFaceFromWebCamera(
      async () => {
        events.push("open-2");
        return second.stream;
      },
      { scanBudgetMs: 3_000 },
    );
    const r1 = await scan1;
    expect(r1?.reasonCode).toBe(FACE_SCAN_REASON.SCAN_ABORTED);
    await vi.waitFor(() => expect(videos.length).toBe(2));
    videos[1]!.setDims(480, 640, 4);
    const r2 = await scan2;
    expect(r2?.payload.vector).toHaveLength(512);
    expect(events.indexOf("stop-1")).toBeGreaterThan(-1);
    expect(events.indexOf("stop-1")).toBeLessThan(events.indexOf("open-2"));
    expect(document.querySelectorAll("video")).toHaveLength(0);
  });
});
