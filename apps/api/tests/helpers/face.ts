import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";

/** Deterministic L2-normalized 512-D probe for API tests (simulates ArcFace output). */
export function face512(seed = 1): number[] {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed + i * 0.017));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Production-shaped face enroll/match payload for tests. */
export function facePayload(seed = 1, extra?: Record<string, unknown>) {
  return {
    modality: BIOMETRIC_MODALITIES.FACE,
    vector: face512(seed),
    modelName: BIOMETRIC_AI_MODEL_NAME,
    modelVersion: BIOMETRIC_AI_MODEL_VERSION,
    confidence: 0.95,
    ...extra,
  };
}
