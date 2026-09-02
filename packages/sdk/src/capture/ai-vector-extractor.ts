import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import { vectorizeFaceFromRgba } from "./face-vectorizer.js";

export type AIVectorPayload = {
  modality: typeof BIOMETRIC_MODALITIES.FACE | typeof BIOMETRIC_MODALITIES.FINGERPRINT;
  vector: number[];
  modelName: string;
  modelVersion: number;
  confidence: number;
};

export type AIVectorExtractorOptions = {
  /** Base URL for face-api model weights (optional peer: @vladmandic/face-api) */
  modelBaseUrl?: string;
  /** Optional ONNX MobileFaceNet model URL (optional peer: onnxruntime-web) */
  onnxModelUrl?: string;
};

function normalize512(v: number[]): number[] {
  const out =
    v.length === BIOMETRIC_AI_EMBEDDING_DIMS ? [...v] : projectTo512(v);
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return out;
  return out.map((x) => x / norm);
}

/** Deterministic projection to 512-D preserving similarity structure */
export function projectTo512(v: number[]): number[] {
  const out = new Array<number>(BIOMETRIC_AI_EMBEDDING_DIMS).fill(0);
  for (let i = 0; i < BIOMETRIC_AI_EMBEDDING_DIMS; i++) {
    let sum = 0;
    for (let j = 0; j < v.length; j++) {
      sum += v[j]! * Math.cos((i + 1) * (j + 1) * 0.017);
    }
    out[i] = sum;
  }
  return normalize512(out);
}

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

async function tryImport(moduleName: string): Promise<unknown | null> {
  try {
    return await import(/* @vite-ignore */ moduleName);
  } catch {
    return null;
  }
}

/**
 * On-device AI face vector extractor.
 * Uses optional @vladmandic/face-api or onnxruntime-web when installed;
 * otherwise in-memory spatial projection (512-D, zero disk).
 */
export class AIVectorExtractor {
  private faceApi: {
    nets: {
      ssdMobilenetv1: { loadFromUri: (u: string) => Promise<void> };
      faceLandmark68Net: { loadFromUri: (u: string) => Promise<void> };
      faceRecognitionNet: { loadFromUri: (u: string) => Promise<void> };
    };
    detectSingleFace: (input: HTMLCanvasElement) => {
      withFaceLandmarks: () => {
        withFaceDescriptor: () => Promise<{
          descriptor: Float32Array | number[];
          detection: { score: number };
        } | null>;
      };
    };
  } | null = null;
  private faceApiReady = false;
  private onnxSession: {
    run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
  } | null = null;
  private readonly options: AIVectorExtractorOptions;

  constructor(options: AIVectorExtractorOptions = {}) {
    this.options = options;
  }

  async loadModels(): Promise<void> {
    if (this.options.onnxModelUrl) {
      const ort = await tryImport("onnxruntime-web");
      if (ort && typeof ort === "object" && "InferenceSession" in ort) {
        const InferenceSession = (ort as { InferenceSession: { create: (url: string, opts: unknown) => Promise<unknown> } })
          .InferenceSession;
        try {
          this.onnxSession = (await InferenceSession.create(this.options.onnxModelUrl, {
            executionProviders: ["wasm"],
          })) as AIVectorExtractor["onnxSession"];
          return;
        } catch {
          /* fall through */
        }
      }
    }

    if (!this.options.modelBaseUrl) return;

    const mod = await tryImport("@vladmandic/face-api");
    if (!mod || typeof mod !== "object" || !("nets" in mod)) return;

    this.faceApi = mod as AIVectorExtractor["faceApi"];
    const base = this.options.modelBaseUrl.replace(/\/$/, "");
    try {
      await Promise.all([
        this.faceApi!.nets.ssdMobilenetv1.loadFromUri(base),
        this.faceApi!.nets.faceLandmark68Net.loadFromUri(base),
        this.faceApi!.nets.faceRecognitionNet.loadFromUri(base),
      ]);
      this.faceApiReady = true;
    } catch {
      this.faceApiReady = false;
    }
  }

  async fromCameraStream(video: HTMLVideoElement): Promise<AIVectorPayload | null> {
    const imageData = captureFrameFromVideo(video);
    if (!imageData) return null;

    try {
      if (this.onnxSession) return await this.inferOnnx(imageData);
      if (this.faceApiReady && this.faceApi) return await this.inferFaceApi(imageData);
      return this.inferSpatial(imageData);
    } finally {
      imageData.data.fill(0);
    }
  }

  async fromImageData(imageData: ImageData): Promise<AIVectorPayload | null> {
    try {
      if (this.onnxSession) return await this.inferOnnx(imageData);
      if (this.faceApiReady && this.faceApi) return await this.inferFaceApi(imageData);
      return this.inferSpatial(imageData);
    } finally {
      imageData.data.fill(0);
    }
  }

  private inferSpatial(imageData: ImageData): AIVectorPayload {
    const { embedding, confidence } = vectorizeFaceFromRgba(
      imageData.data,
      imageData.width,
      imageData.height,
      BIOMETRIC_AI_EMBEDDING_DIMS,
    );
    return {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: embedding,
      modelName: "spatial_fallback_v1",
      modelVersion: 1,
      confidence,
    };
  }

  private async inferFaceApi(imageData: ImageData): Promise<AIVectorPayload | null> {
    const faceapi = this.faceApi!;
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(imageData, 0, 0);

    const detection = await faceapi
      .detectSingleFace(canvas)
      .withFaceLandmarks()
      .withFaceDescriptor();

    canvas.width = 0;
    canvas.height = 0;

    if (!detection) return this.inferSpatial(imageData);

    const descriptor = Array.from(detection.descriptor as ArrayLike<number>);
    return {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: projectTo512(descriptor),
      modelName: BIOMETRIC_AI_MODEL_NAME,
      modelVersion: 1,
      confidence: detection.detection.score,
    };
  }

  private async inferOnnx(imageData: ImageData): Promise<AIVectorPayload | null> {
    const ort = await tryImport("onnxruntime-web");
    if (!ort || typeof ort !== "object" || !("Tensor" in ort) || !this.onnxSession) {
      return this.inferSpatial(imageData);
    }

    const Tensor = (ort as { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown })
      .Tensor;
    const input = new Float32Array(imageData.width * imageData.height * 3);
    let o = 0;
    for (let i = 0; i < imageData.data.length; i += 4) {
      input[o++] = (imageData.data[i] ?? 0) / 255;
      input[o++] = (imageData.data[i + 1] ?? 0) / 255;
      input[o++] = (imageData.data[i + 2] ?? 0) / 255;
    }

    const tensor = new Tensor("float32", input, [1, 3, imageData.height, imageData.width]);
    const outputs = await this.onnxSession.run({ input: tensor });
    const first = Object.values(outputs)[0];
    if (!first?.data) return this.inferSpatial(imageData);

    const raw = Array.from(first.data);
    return {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: normalize512(raw),
      modelName: BIOMETRIC_AI_MODEL_NAME,
      modelVersion: 1,
      confidence: 0.85,
    };
  }
}

let sharedExtractor: AIVectorExtractor | null = null;

export function createAIVectorExtractor(options?: AIVectorExtractorOptions): AIVectorExtractor {
  return new AIVectorExtractor(options);
}

export async function getSharedAIVectorExtractor(
  options?: AIVectorExtractorOptions,
): Promise<AIVectorExtractor> {
  if (!sharedExtractor) {
    sharedExtractor = new AIVectorExtractor(options);
    await sharedExtractor.loadModels();
  }
  return sharedExtractor;
}

export const aiVectorExtractor = {
  create: createAIVectorExtractor,
  getShared: getSharedAIVectorExtractor,
  projectTo512,
};
