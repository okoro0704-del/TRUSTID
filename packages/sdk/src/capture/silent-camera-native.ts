import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { getSharedAIVectorExtractor } from "./ai-vector-extractor.js";

export type SilentFaceCaptureBridge = {
  isAvailable(): Promise<{ available: boolean }>;
  captureFaceVector(): Promise<{
    /** Preferred: raw JPEG for shared JS vectorizer (cross-platform identity) */
    jpegBase64?: string;
    embedding?: number[];
    confidence: number;
    width?: number;
    height?: number;
  } | null>;
};

export type NativeSilentFaceResult = {
  payload: BiometricPayload;
  confidence: number;
};

async function jpegBase64ToImageData(jpegBase64: string): Promise<ImageData | null> {
  if (typeof document === "undefined" || typeof atob === "undefined") return null;
  try {
    const bin = atob(jpegBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
    return imageData;
  } catch {
    return null;
  }
}

/**
 * Capacitor plugin TrustIdSilentFaceCapture.
 * Frames are vectorized in JS with the same AI extractor as web/PWA.
 */
export async function captureSilentFaceFromNative(
  bridge: SilentFaceCaptureBridge,
): Promise<NativeSilentFaceResult | null> {
  try {
    const avail = await bridge.isAvailable();
    if (!avail.available) return null;

    const result = await bridge.captureFaceVector();
    if (!result) return null;

    if (result.jpegBase64) {
      const imageData = await jpegBase64ToImageData(result.jpegBase64);
      if (!imageData) return null;
      try {
        const extractor = await getSharedAIVectorExtractor();
        const ai = await extractor.fromImageData(imageData);
        if (!ai) return null;
        return {
          confidence: Math.max(result.confidence, ai.confidence),
          payload: {
            modality: BIOMETRIC_MODALITIES.FACE,
            vector: ai.vector,
            modelName: ai.modelName,
            modelVersion: ai.modelVersion,
          },
        };
      } finally {
        imageData.data.fill(0);
      }
    }

    return null;
  } catch {
    return null;
  }
}
