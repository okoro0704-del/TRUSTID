import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";

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

    return {
      confidence: result.confidence,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        embedding: result.embedding,
      },
    };
  } catch {
    return null;
  }
}
