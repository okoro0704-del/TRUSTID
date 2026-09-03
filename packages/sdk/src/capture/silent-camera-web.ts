import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { getSharedAIVectorExtractor } from "./ai-vector-extractor.js";

export type SilentWebCaptureResult = {
  payload: BiometricPayload;
  confidence: number;
};

export type MediaStreamFactory = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

function createHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.setAttribute("muted", "true");
  video.muted = true;
  video.style.cssText =
    "display:none;position:fixed;width:0;height:0;opacity:0;pointer-events:none;visibility:hidden";
  document.body.appendChild(video);
  return video;
}

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  });
}

function waitForFrame(video: HTMLVideoElement, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Camera frame timeout")), timeoutMs);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    if (video.readyState >= 2 && video.videoWidth > 0) {
      done();
      return;
    }
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("playing", done, { once: true });
  });
}

/**
 * Off-screen single-frame capture via hidden video element + on-device AI vectorization.
 * All camera tracks are stopped immediately after inference; no frames persisted to disk.
 */
export async function captureSilentFaceFromWebCamera(
  getStream?: MediaStreamFactory,
): Promise<SilentWebCaptureResult | null> {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return null;
  }

  const streamFactory =
    getStream ??
    (navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : null);

  if (!streamFactory) return null;

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;

  try {
    stream = await streamFactory({
      video: {
        facingMode: "user",
        width: { ideal: 320 },
        height: { ideal: 240 },
      },
      audio: false,
    });

    video = createHiddenVideo();
    video.srcObject = stream;
    await video.play();
    await waitForFrame(video);

    const extractor = await getSharedAIVectorExtractor();
    const ai = await extractor.fromCameraStream(video);
    if (!ai) return null;

    return {
      confidence: ai.confidence,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: ai.vector,
        modelName: ai.modelName,
        modelVersion: ai.modelVersion,
        confidence: ai.confidence,
      },
    };
  } catch {
    return null;
  } finally {
    stopStream(stream);
    if (video) {
      video.srcObject = null;
      video.remove();
    }
  }
}

export function isSilentWebCameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}
