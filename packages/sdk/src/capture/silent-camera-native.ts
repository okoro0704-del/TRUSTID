import { BIOMETRIC_AI_MODEL_NAME, BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { projectTo512 } from "./ai-vector-extractor.js";

export type SilentFaceCaptureBridge = {
  isAvailable(): Promise<{ available: boolean }>;
  captureFaceVector(): Promise<{
    embedding: number[];
    confidence: number;
  } | null>;
};

export type NativeSilentFaceResult = {
  payload: BiometricPayload;
  confidence: number;
};

/** Capacitor plugin name: TrustIdSilentFaceCapture */
export async function captureSilentFaceFromNative(
  bridge: SilentFaceCaptureBridge,
): Promise<NativeSilentFaceResult | null> {
  try {
    const avail = await bridge.isAvailable();
    if (!avail.available) return null;

    const result = await bridge.captureFaceVector();
    if (!result || !result.embedding?.length) return null;

    // Project native spatial embedding → 512-D cloud AI vector
    const vector = projectTo512(result.embedding);

    return {
      confidence: result.confidence,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector,
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: 1,
        embedding: result.embedding,
      },
    };
  } catch {
    return null;
  }
}
