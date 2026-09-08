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
import { faceCaptureDiag } from "./biometric/face-capture-diag.js";

export type { AIVectorPayload } from "./biometric/types.js";
export type { FacePipelineOptions };

/** Default cold-start budget for MediaPipe + ArcFace (parallel warm).
 * Measured: Face Landmarker create ~22s cold; WebGPU without adapter hung ~37s.
 * Budget covers MediaPipe + margin after fast WebGPU probe → WASM fallback.
 */
export const DEFAULT_BIOMETRIC_WARMUP_TIMEOUT_MS = 45_000;

/** Short timeout for unit/jsdom environments that cannot load real models. */
export const TEST_BIOMETRIC_WARMUP_TIMEOUT_MS = 3_000;

function readNodeEnv(name: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env[name];
    }
  } catch {
    /* browsers may stub `process` without `env` */
  }
  return undefined;
}

function resolveWarmupTimeoutMs(explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fromEnv = readNodeEnv("TRUSTID_BIOMETRIC_WARMUP_MS");
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Vitest / NODE_ENV=test keep a short fail-closed budget.
  if (readNodeEnv("VITEST") || readNodeEnv("NODE_ENV") === "test") {
    return TEST_BIOMETRIC_WARMUP_TIMEOUT_MS;
  }
  return DEFAULT_BIOMETRIC_WARMUP_TIMEOUT_MS;
}

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
  /** Override cold-start warm-up timeout (ms). */
  warmupTimeoutMs?: number;
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
  private loadPromise: Promise<void> | null = null;

  constructor(options: AIVectorExtractorOptions = {}) {
    this.options = options;
  }

  async loadModels(): Promise<void> {
    if (this.ready) return;
    if (this.loadPromise) return this.loadPromise;

    const timeoutMs = resolveWarmupTimeoutMs(this.options.warmupTimeoutMs);
    const base = this.options.modelBaseUrl ?? "/models/trustid";
    const started = performance.now();

    this.loadPromise = (async () => {
      faceCaptureDiag({
        stage: "model_init_start",
        component: "extractor",
        success: true,
      });

      // Initialize independently so diagnostics can attribute MediaPipe vs ArcFace.
      let mediapipeOk = false;
      let arcfaceOk = false;
      let mediapipeError: string | null = null;
      let arcfaceError: string | null = null;

      const warm = (async () => {
        const { getSharedFaceLandmarker } = await import(
          "./biometric/detector-mediapipe.js"
        );
        const {
          getArcFaceSession,
          getLastArcFaceInitError,
        } = await import("./biometric/recognizer-arcface.js");

        // Initialize independently (sequential) so diagnostics attribute each
        // stage and WASM runtimes do not contend on cold start.
        const mediapipeResult = await getSharedFaceLandmarker(base)
          .then(() => {
            mediapipeOk = true;
            faceCaptureDiag({
              stage: "mediapipe_warmup_ok",
              component: "mediapipe",
              success: true,
              ms: Math.round(performance.now() - started),
            });
            return true as const;
          })
          .catch((err: unknown) => {
            mediapipeError =
              err instanceof Error ? err.message : String(err);
            faceCaptureDiag({
              stage: "mediapipe_warmup_failed",
              component: "mediapipe",
              success: false,
              errorMessage: mediapipeError,
            });
            return false as const;
          });

        const arcfaceResult = await getArcFaceSession(base)
          .then(() => {
            arcfaceOk = true;
            faceCaptureDiag({
              stage: "arcface_warmup_ok",
              component: "arcface",
              success: true,
              ms: Math.round(performance.now() - started),
            });
            return true as const;
          })
          .catch((err: unknown) => {
            arcfaceError =
              getLastArcFaceInitError() ??
              (err instanceof Error ? err.message : String(err));
            faceCaptureDiag({
              stage: "arcface_warmup_failed",
              component: "arcface",
              success: false,
              errorMessage: arcfaceError,
            });
            return false as const;
          });

        if (!mediapipeResult || !arcfaceResult) {
          const parts = [
            `MediaPipe=${mediapipeOk ? "SUCCESS" : "FAILURE"}`,
            `ArcFace=${arcfaceOk ? "SUCCESS" : "FAILURE"}`,
          ];
          const detail = [mediapipeError, arcfaceError]
            .filter(Boolean)
            .join(" | ");
          throw new Error(
            `Biometric model init failed (${parts.join(", ")})${detail ? `: ${detail}` : ""}`,
          );
        }
      })();

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Biometric model warm-up timed out after ${timeoutMs}ms ` +
                `(mediapipe=${mediapipeOk ? "ok" : "pending"}, arcface=${arcfaceOk ? "ok" : "pending"})`,
            ),
          );
        }, timeoutMs);
      });

      try {
        await Promise.race([warm, timeout]);
        this.ready = true;
        this.lastError = null;
        faceCaptureDiag({
          stage: "model_init_complete",
          component: "extractor",
          success: true,
          ms: Math.round(performance.now() - started),
          modelReady: true,
        });
      } catch (err) {
        this.ready = false;
        this.lastError =
          mediapipeError ??
          arcfaceError ??
          (err instanceof Error ? err.message : String(err));
        faceCaptureDiag({
          stage: "model_init_error",
          component: "extractor",
          success: false,
          ms: Math.round(performance.now() - started),
          modelReady: false,
          errorMessage: this.lastError,
          errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
        });
        // Allow retry on next getShared call.
        this.loadPromise = null;
        if (!this.options.allowSpatialDevFallback) {
          throw new BiometricPipelineError(
            BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
            this.lastError,
          );
        }
      }
    })();

    return this.loadPromise;
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
let sharedLoadInflight: Promise<AIVectorExtractor> | null = null;

export function createAIVectorExtractor(
  options?: AIVectorExtractorOptions,
): AIVectorExtractor {
  return new AIVectorExtractor(options);
}

/**
 * Shared extractor with concurrency-safe init and retry after failed warm-up.
 * Model integrity remains mandatory inside getArcFaceSession / landmarker load.
 * Failed init does not permanently poison the singleton; lastError is preserved
 * on the returned instance for diagnostics.
 */
export async function getSharedAIVectorExtractor(
  options?: AIVectorExtractorOptions,
): Promise<AIVectorExtractor> {
  if (sharedExtractor?.isReady()) return sharedExtractor;

  if (sharedLoadInflight) return sharedLoadInflight;

  sharedLoadInflight = (async () => {
    const extractor = sharedExtractor ?? new AIVectorExtractor(options);
    sharedExtractor = extractor;
    try {
      await extractor.loadModels();
      return extractor;
    } catch (err) {
      const detail =
        extractor.getLastError() ??
        (err instanceof Error ? err.message : String(err));
      faceCaptureDiag({
        stage: "shared_extractor_init_failed",
        component: "extractor",
        success: false,
        modelReady: false,
        errorMessage: detail,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
      });
      // Keep fail-closed: return the same instance so callers can read lastError,
      // but clear the singleton so the *next* getShared can retry a fresh load.
      sharedExtractor = null;
      return extractor;
    } finally {
      sharedLoadInflight = null;
    }
  })();

  return sharedLoadInflight;
}

/** Test helper — drop shared extractor so the next call reloads. */
export function resetSharedAIVectorExtractorForTests(): void {
  sharedExtractor = null;
  sharedLoadInflight = null;
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
