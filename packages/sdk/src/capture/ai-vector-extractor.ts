/**
 * Public face biometric extractor API.
 * Production path: MediaPipe detect → ArcFace align/embed.
 * spatial_fallback_v1 is DEV/TEST only and never used silently.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import { detectFacePresence } from "./face-presence.js";
import { vectorizeFaceFromRgba } from "./face-vectorizer.js";
import {
  extractFaceEmbeddingFromImageData,
  type FacePipelineOptions,
} from "./biometric/pipeline.js";
import type { AIVectorPayload } from "./biometric/types.js";
import { BiometricPipelineError } from "./biometric/errors.js";

export type { AIVectorPayload } from "./biometric/types.js";
export type { FacePipelineOptions };

export type AIVectorExtractorOptions = FacePipelineOptions & {
  /**
   * @deprecated Ignored. Production never loads arbitrary unverified URLs
   * without the TrustID model manifest + integrity check.
   */
  modelBaseUrl?: string;
  /** @deprecated Removed — face-api path deleted. */
  onnxModelUrl?: string;
  /**
   * Explicit DEV/TEST flag. When true, spatial_fallback_dev_v1 may be used
   * ONLY if real models are unavailable. Default false.
   */
  allowSpatialDevFallback?: boolean;
};

function captureFrameFromVideo(video: HTMLVideoElement): ImageData | null {
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
  canvas.width = 0;
  canvas.height = 0;
  return imageData;
}

/**
 * @deprecated Do not use for face identity. Kept for fingerprint keystore
 * hashing helpers only — NOT a biometric projection.
 */
export function projectTo512(v: number[]): number[] {
  const out = new Array<number>(BIOMETRIC_AI_EMBEDDING_DIMS).fill(0);
  const n = Math.min(v.length, BIOMETRIC_AI_EMBEDDING_DIMS);
  for (let i = 0; i < n; i++) out[i] = v[i] ?? 0;
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return out;
  return out.map((x) => x / norm);
}

function spatialDevOnly(imageData: ImageData): AIVectorPayload | null {
  const presence = detectFacePresence(
    imageData.data,
    imageData.width,
    imageData.height,
  );
  if (!presence.present) return null;
  const { embedding, confidence } = vectorizeFaceFromRgba(
    imageData.data,
    imageData.width,
    imageData.height,
    BIOMETRIC_AI_EMBEDDING_DIMS,
  );
  const score = Math.min(confidence, presence.confidence);
  if (score < 0.42) return null;
  return {
    modality: BIOMETRIC_MODALITIES.FACE,
    vector: embedding,
    modelName: "spatial_fallback_dev_v1",
    modelVersion: 1,
    confidence: score,
    errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
    errorMessage: "DEV spatial fallback — not valid for production identity",
  };
}

/**
 * On-device face embedding extractor (production ArcFace pipeline).
 */
export class AIVectorExtractor {
  private readonly options: AIVectorExtractorOptions;
  private ready = false;
  private lastError: string | null = null;

  constructor(options: AIVectorExtractorOptions = {}) {
    this.options = options;
  }

  async loadModels(): Promise<void> {
    // Eager warm-up with a hard timeout so jsdom/tests fail closed quickly
    const base = this.options.modelBaseUrl ?? "/models/trustid";
    const warm = (async () => {
      const { getSharedFaceLandmarker } = await import("./biometric/detector-mediapipe.js");
      const { getArcFaceSession } = await import("./biometric/recognizer-arcface.js");
      await getSharedFaceLandmarker(base);
      await getArcFaceSession(base);
    })();

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Biometric model warm-up timed out")),
        3_000,
      );
    });

    try {
      await Promise.race([warm, timeout]);
      this.ready = true;
      this.lastError = null;
    } catch (err) {
      this.ready = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (!this.options.allowSpatialDevFallback) {
        throw new BiometricPipelineError(
          BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
          this.lastError,
        );
      }
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async fromCameraStream(video: HTMLVideoElement): Promise<AIVectorPayload | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 180 + attempt * 80));
      }
      const imageData = captureFrameFromVideo(video);
      if (!imageData) continue;
      try {
        const result = await this.fromImageData(imageData);
        if (result && !result.errorCode) return result;
        if (result?.errorCode === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE) {
          return result;
        }
      } finally {
        imageData.data.fill(0);
      }
    }
    return null;
  }

  async fromImageData(imageData: ImageData): Promise<AIVectorPayload | null> {
    const result = await extractFaceEmbeddingFromImageData(imageData, {
      modelBaseUrl: this.options.modelBaseUrl ?? "/models/trustid",
      rejectMultipleFaces: this.options.rejectMultipleFaces,
      allowDevPadBypass: this.options.allowDevPadBypass,
      pad: this.options.pad,
      preliminaryQualityGate: (img: ImageData) => {
        // Optional cheap gate — never establishes identity face presence alone
        const p = detectFacePresence(img.data, img.width, img.height);
        return p.present || p.confidence > 0.2;
      },
    });

    if (result.ok) return result.payload;

    if (
      result.code === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE &&
      this.options.allowSpatialDevFallback
    ) {
      return spatialDevOnly(imageData);
    }

    return {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: [],
      modelName: "none",
      modelVersion: 0,
      confidence: 0,
      errorCode: result.code,
      errorMessage: result.message,
    };
  }
}

let sharedExtractor: AIVectorExtractor | null = null;

export function createAIVectorExtractor(
  options?: AIVectorExtractorOptions,
): AIVectorExtractor {
  return new AIVectorExtractor(options);
}

export async function getSharedAIVectorExtractor(
  options?: AIVectorExtractorOptions,
): Promise<AIVectorExtractor> {
  if (!sharedExtractor) {
    sharedExtractor = new AIVectorExtractor(options);
    try {
      await sharedExtractor.loadModels();
    } catch {
      // Caller inspects payloads / errors; do not spatial-fallback here.
    }
  }
  return sharedExtractor;
}

export const aiVectorExtractor = {
  create: createAIVectorExtractor,
  getShared: getSharedAIVectorExtractor,
  /** @deprecated Not a biometric transform */
  projectTo512,
};

export { extractFaceEmbeddingFromImageData } from "./biometric/pipeline.js";
export { enrollFromImageFrames, buildFaceTemplateEnvelope } from "./biometric/enrollment.js";
export {
  FailClosedPadDetector,
  DevBypassPadDetector,
  MediaPipeBlinkPadDetector,
  createProductionPadDetector,
  getPadDeploymentStatus,
  PAD_STATUS,
  toFormalPadResult,
} from "./biometric/pad.js";
export type { FacePresentationAttackDetector, FacePadResult } from "./biometric/types.js";
