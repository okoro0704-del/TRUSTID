import { describe, expect, it, vi, afterEach } from "vitest";
import {
  BIOMETRIC_FACE_EMBEDDING_DIMS,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import { vectorizeFaceFromRgba } from "../src/capture/face-vectorizer.js";
import { captureSilentFaceFromWebCamera } from "../src/capture/silent-camera-web.js";
import { SilentCameraCapturer } from "../src/capture/silent-camera-capturer.js";

describe("face-vectorizer", () => {
  it("produces a normalized 128-dimensional vector", () => {
    const width = 64;
    const height = 64;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 120;
      rgba[i + 1] = 90;
      rgba[i + 2] = 70;
      rgba[i + 3] = 255;
    }

    const { embedding, confidence } = vectorizeFaceFromRgba(rgba, width, height);
    expect(embedding).toHaveLength(BIOMETRIC_FACE_EMBEDDING_DIMS);
    const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(confidence).toBeGreaterThan(0);
  });
});

describe("silent-camera-web", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("stops camera tracks immediately after capture", async () => {
    const stop = vi.fn();
    const fakeRgba = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < fakeRgba.length; i += 4) {
      fakeRgba[i] = 100;
      fakeRgba[i + 1] = 80;
      fakeRgba[i + 2] = 60;
      fakeRgba[i + 3] = 255;
    }

    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: 32, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 32, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    video.play = vi.fn().mockResolvedValue(undefined);
    video.remove = vi.fn(function (this: HTMLVideoElement) {
      this.parentElement?.removeChild(this);
    });

    const canvas = {
      width: 32,
      height: 32,
      getContext: () => ({
        drawImage: vi.fn(),
        getImageData: () => ({ data: fakeRgba, width: 32, height: 32 }),
      }),
    };

    const origCreate = HTMLDocument.prototype.createElement;
    vi.spyOn(document, "createElement").mockImplementation(function (this: Document, tag: string) {
      if (tag === "video") return video;
      if (tag === "canvas") return canvas as unknown as HTMLCanvasElement;
      return origCreate.call(this, tag);
    });

    const getStream = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
    });

    const result = await captureSilentFaceFromWebCamera(getStream);
    expect(result?.payload.modality).toBe(BIOMETRIC_MODALITIES.FACE);
    expect(result?.payload.vector).toHaveLength(BIOMETRIC_AI_EMBEDDING_DIMS);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(video.remove).toHaveBeenCalled();
  });
});

describe("SilentCameraCapturer", () => {
  it("falls back to fingerprint when native face capture is unavailable", async () => {
    const capturer = new SilentCameraCapturer({
      nativeBridge: {
        isAvailable: async () => ({ available: false }),
        captureFaceVector: async () => null,
      },
      runWebAuthn: async () => ({
        id: "cred-id",
        rawId: "raw",
        response: { authenticatorData: "ad", signature: "sig" },
      }),
    });

    const payload = await capturer.captureWithFallback();
    expect(payload?.modality).toBe(BIOMETRIC_MODALITIES.FINGERPRINT);
  });

  it("returns face payload from native bridge when confidence is sufficient", async () => {
    const embedding = Array.from({ length: BIOMETRIC_FACE_EMBEDDING_DIMS }, (_, i) =>
      i === 0 ? 1 : 0,
    );
    const capturer = new SilentCameraCapturer({
      nativeBridge: {
        isAvailable: async () => ({ available: true }),
        captureFaceVector: async () => ({ embedding, confidence: 0.9 }),
      },
    });

    const payload = await capturer.captureWithFallback();
    expect(payload?.modality).toBe(BIOMETRIC_MODALITIES.FACE);
    expect(payload?.embedding).toHaveLength(BIOMETRIC_FACE_EMBEDDING_DIMS);
  });
});
