/**
 * Silent web capture with production ArcFace pipeline + multi-frame blink PAD.
 */
import { BIOMETRIC_ERROR_CODES, BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { getSharedAIVectorExtractor } from "./ai-vector-extractor.js";
import { MediaPipeBlinkPadDetector } from "./biometric/pad-blink.js";
import { extractFaceEmbeddingFromImageData } from "./biometric/pipeline.js";
import { detectFacesInImageData } from "./biometric/detector-mediapipe.js";
import {
  faceCaptureDiag,
  summarizeImageDataSignal,
} from "./biometric/face-capture-diag.js";

export type SilentWebCaptureResult = {
  payload: BiometricPayload;
  confidence: number;
  errorCode?: string;
  errorMessage?: string;
};

export type MediaStreamFactory = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

function createHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.setAttribute("muted", "true");
  video.muted = true;
  video.autoplay = true;
  // Keep the element renderable. display:none / 0×0 often freezes frame decode
  // in Chromium, producing blank ImageData and MediaPipe NO_FACE.
  video.style.cssText =
    "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1";
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

function grabFrame(video: HTMLVideoElement): ImageData | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w <= 0 || h <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

/**
 * Off-screen multi-frame capture: ArcFace embed + active blink PAD.
 * Never uses spatial_fallback. Never logs embeddings.
 */
export async function captureSilentFaceFromWebCamera(
  getStream?: MediaStreamFactory,
  options?: { signal?: AbortSignal },
): Promise<SilentWebCaptureResult | null> {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return null;
  }

  const signal = options?.signal;
  if (signal?.aborted) {
    return {
      confidence: 0,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: [],
        modelName: "none",
        modelVersion: 0,
        confidence: 0,
      },
      errorCode: BIOMETRIC_ERROR_CODES.NO_FACE,
      errorMessage: "Capture aborted",
    };
  }

  const streamFactory =
    getStream ??
    (navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : null);

  if (!streamFactory) return null;

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  const pad = new MediaPipeBlinkPadDetector();

  const aborted = () => Boolean(signal?.aborted);

  try {
    stream = await streamFactory({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    if (aborted()) {
      return {
        confidence: 0,
        payload: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: [],
          modelName: "none",
          modelVersion: 0,
          confidence: 0,
        },
        errorCode: BIOMETRIC_ERROR_CODES.NO_FACE,
        errorMessage: "Capture aborted",
      };
    }

    video = createHiddenVideo();
    video.srcObject = stream;
    await video.play();
    await waitForFrame(video);

    faceCaptureDiag({
      stage: "camera_ready",
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      modelReady: true,
    });

    // Warm models early — fail closed immediately if unavailable
    const extractor = await getSharedAIVectorExtractor({
      modelBaseUrl: "/models/trustid",
      pad,
    });
    faceCaptureDiag({
      stage: "extractor_ready_check",
      modelReady: extractor.isReady(),
      errorMessage: extractor.isReady()
        ? undefined
        : extractor.getLastError() ?? "not ready",
    });
    if (!extractor.isReady()) {
      return {
        confidence: 0,
        payload: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: [],
          modelName: "none",
          modelVersion: 0,
          confidence: 0,
        },
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
        errorMessage:
          extractor.getLastError() ??
          "Face biometric models unavailable. Install /models/trustid artifacts.",
      };
    }

    let lastEmbed: SilentWebCaptureResult | null = null;
    let framesGrabbed = 0;
    let framesWithSignal = 0;
    let framesWithFaces = 0;

    for (let i = 0; i < 24; i++) {
      if (aborted()) {
        return {
          confidence: 0,
          payload: {
            modality: BIOMETRIC_MODALITIES.FACE,
            vector: [],
            modelName: "none",
            modelVersion: 0,
            confidence: 0,
          },
          errorCode: BIOMETRIC_ERROR_CODES.NO_FACE,
          errorMessage: "Capture aborted",
        };
      }
      await new Promise((r) => setTimeout(r, 120));
      const frame = grabFrame(video);
      if (!frame) {
        faceCaptureDiag({
          stage: "grab_frame_empty",
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        });
        continue;
      }
      framesGrabbed += 1;
      const signalMeta = summarizeImageDataSignal(frame);
      if (signalMeta.hasNonZeroPixels) framesWithSignal += 1;
      if (i === 0 || i === 11 || i === 23) {
        faceCaptureDiag({
          stage: "grab_frame",
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          imageWidth: frame.width,
          imageHeight: frame.height,
          hasNonZeroPixels: signalMeta.hasNonZeroPixels,
          sampledNonZeroRatio: Number(
            signalMeta.sampledNonZeroRatio.toFixed(3),
          ),
          meanLumaApprox: signalMeta.meanLumaApprox,
        });
      }

      try {
        let det;
        try {
          det = await detectFacesInImageData(frame, "/models/trustid");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/unavailable|integrity|missing|mediapipe|onnx/i.test(msg)) {
            return {
              confidence: 0,
              payload: {
                modality: BIOMETRIC_MODALITIES.FACE,
                vector: [],
                modelName: "none",
                modelVersion: 0,
                confidence: 0,
              },
              errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
              errorMessage: msg,
            };
          }
          continue;
        }
        if (det.faces.length > 0) framesWithFaces += 1;
        pad.observeBlendshapes(det.blendshapes?.[0]);

        const extracted = await extractFaceEmbeddingFromImageData(frame, {
          modelBaseUrl: "/models/trustid",
          skipPad: true,
          rejectMultipleFaces: true,
        });

        if (extracted.ok) {
          lastEmbed = {
            confidence: extracted.payload.confidence,
            payload: {
              modality: BIOMETRIC_MODALITIES.FACE,
              vector: extracted.payload.vector,
              modelName: extracted.payload.modelName,
              modelVersion: extracted.payload.modelVersion,
              confidence: extracted.payload.confidence,
            },
          };
          const padCheck = await pad.evaluate();
          if (padCheck.decision === "accept") {
            faceCaptureDiag({
              stage: "capture_accept",
              faceLandmarksCount: det.faces.length,
              modelReady: true,
            });
            return {
              ...lastEmbed,
              payload: {
                ...lastEmbed.payload,
              },
            };
          }
        } else if (
          extracted.code === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE
        ) {
          return {
            confidence: 0,
            payload: {
              modality: BIOMETRIC_MODALITIES.FACE,
              vector: [],
              modelName: "none",
              modelVersion: 0,
              confidence: 0,
            },
            errorCode: extracted.code,
            errorMessage: extracted.message,
          };
        } else if (i === 0 || i === 11 || i === 23) {
          faceCaptureDiag({
            stage: "extract_rejected",
            faceLandmarksCount: det.faces.length,
            errorCode: extracted.code,
            errorMessage: extracted.message,
          });
        }
      } finally {
        frame.data.fill(0);
      }
    }

    faceCaptureDiag({
      stage: "capture_exhausted",
      errorCode: lastEmbed
        ? BIOMETRIC_ERROR_CODES.LIVENESS_FAILED
        : BIOMETRIC_ERROR_CODES.NO_FACE,
      faceLandmarksCount: framesWithFaces,
      // Reuse fields for aggregate counters (safe metadata only).
      imageWidth: framesGrabbed,
      imageHeight: framesWithSignal,
    });

    if (lastEmbed) {
      // Had face embeds but blink PAD never passed
      return {
        ...lastEmbed,
        payload: { ...lastEmbed.payload, vector: [] },
        confidence: 0,
        errorCode: BIOMETRIC_ERROR_CODES.LIVENESS_FAILED,
        errorMessage: "Blink to confirm liveness, then try again",
      };
    }

    return {
      confidence: 0,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: [],
        modelName: "none",
        modelVersion: 0,
        confidence: 0,
      },
      errorCode: BIOMETRIC_ERROR_CODES.NO_FACE,
      errorMessage: "No usable face frame captured",
    };
  } catch (err) {
    return {
      confidence: 0,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: [],
        modelName: "none",
        modelVersion: 0,
        confidence: 0,
      },
      errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
      errorMessage: err instanceof Error ? err.message : "Capture failed",
    };
  } finally {
    stopStream(stream);
    if (video) {
      video.srcObject = null;
      video.remove();
    }
    pad.reset();
  }
}

export function isSilentWebCameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * Enrollment capture: active blink liveness, then multi-frame quality-filtered
 * aggregation via enrollFromImageFrames (mean / quality-weighted primary).
 * Auth path remains captureSilentFaceFromWebCamera (single accepted frame).
 */
export async function captureSilentFaceEnrollmentFromWebCamera(
  getStream?: MediaStreamFactory,
  options: { minAccepted?: number; maxFrames?: number } = {},
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

  const { enrollFromImageFrames } = await import("./biometric/enrollment.js");
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  const pad = new MediaPipeBlinkPadDetector();
  const frames: ImageData[] = [];
  const minAccepted = options.minAccepted ?? 3;
  const maxFrames = options.maxFrames ?? 12;

  try {
    stream = await streamFactory({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    video = createHiddenVideo();
    video.srcObject = stream;
    await video.play();
    await waitForFrame(video);

    const extractor = await getSharedAIVectorExtractor({
      modelBaseUrl: "/models/trustid",
      pad,
    });
    if (!extractor.isReady()) {
      return {
        confidence: 0,
        payload: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: [],
          modelName: "none",
          modelVersion: 0,
          confidence: 0,
        },
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
        errorMessage:
          extractor.getLastError() ??
          "Face biometric models unavailable. Install /models/trustid artifacts.",
      };
    }

    let blinkOk = false;
    for (let i = 0; i < 32; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const frame = grabFrame(video);
      if (!frame) continue;
      try {
        const det = await detectFacesInImageData(frame, "/models/trustid");
        pad.observeBlendshapes(det.blendshapes?.[0]);
        const padCheck = await pad.evaluate();
        if (padCheck.decision === "accept") {
          blinkOk = true;
          frames.push(frame);
          break;
        }
      } catch {
        /* continue */
      }
    }

    if (!blinkOk) {
      return {
        confidence: 0,
        payload: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: [],
          modelName: "none",
          modelVersion: 0,
          confidence: 0,
        },
        errorCode: BIOMETRIC_ERROR_CODES.LIVENESS_FAILED,
        errorMessage: "Blink to confirm liveness, then try again",
      };
    }

    for (let i = 0; i < maxFrames && frames.length < maxFrames; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const frame = grabFrame(video);
      if (frame) frames.push(frame);
    }

    const enrolled = await enrollFromImageFrames(frames, {
      modelBaseUrl: "/models/trustid",
      skipPad: true,
      rejectMultipleFaces: true,
      minAccepted,
      qualityWeighted: true,
    });

    for (const f of frames) {
      try {
        f.data.fill(0);
      } catch {
        /* ignore */
      }
    }

    if (!enrolled.primary) {
      return {
        confidence: 0,
        payload: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: [],
          modelName: "none",
          modelVersion: 0,
          confidence: 0,
        },
        errorCode: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
        errorMessage:
          enrolled.rejected.map((r) => r.message).join("; ") ||
          "Enrollment needs more high-quality frames",
      };
    }

    return {
      confidence: enrolled.primary.confidence,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: enrolled.primary.vector,
        modelName: enrolled.primary.modelName,
        modelVersion: enrolled.primary.modelVersion,
        confidence: enrolled.primary.confidence,
      },
    };
  } catch (err) {
    return {
      confidence: 0,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: [],
        modelName: "none",
        modelVersion: 0,
        confidence: 0,
      },
      errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
      errorMessage: err instanceof Error ? err.message : "Enrollment capture failed",
    };
  } finally {
    stopStream(stream);
    if (video) {
      video.srcObject = null;
      video.remove();
    }
    pad.reset();
  }
}

