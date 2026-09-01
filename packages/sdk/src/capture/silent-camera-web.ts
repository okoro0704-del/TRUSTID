import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { vectorizeFaceFromRgba } from "./face-vectorizer.js";

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
 * Off-screen single-frame capture via hidden video element.
 * All camera tracks are stopped immediately after vectorization.
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

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const { embedding, confidence } = vectorizeFaceFromRgba(
      imageData.data,
      width,
      height,
    );

    return {
      confidence,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        embedding,
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
