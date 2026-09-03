import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { embeddingFromBytes } from "./embedding.js";
import { projectTo512 } from "./ai-vector-extractor.js";

export type FingerprintTemplateBridge = {
  captureFingerprintTemplate(options?: {
    reason?: string;
  }): Promise<{
    ok: boolean;
    method?: string;
    publicKeyBase64?: string;
    keyAlias?: string;
  }>;
  getAvailability?(): Promise<{ available?: boolean; enrolled?: boolean }>;
};

function decodeBase64(raw: string): Uint8Array {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a stable 512-D fingerprint-backup vector from Keystore public key bytes. */
export function fingerprintVectorFromPublicKey(publicKeyBase64: string): number[] {
  const bytes = decodeBase64(publicKeyBase64);
  const base = embeddingFromBytes(bytes, BIOMETRIC_AI_EMBEDDING_DIMS);
  return projectTo512(base);
}

export function fingerprintPayloadFromPublicKey(
  publicKeyBase64: string,
): BiometricPayload {
  const vector = fingerprintVectorFromPublicKey(publicKeyBase64);
  return {
    modality: BIOMETRIC_MODALITIES.FINGERPRINT,
    vector,
    embedding: vector,
    modelName: `${BIOMETRIC_AI_MODEL_NAME}_fp_keystore`,
    modelVersion: 1,
  };
}

/**
 * Capture fingerprint backup template via native BiometricPrompt + Keystore.
 */
export async function captureNativeFingerprintTemplate(
  bridge: FingerprintTemplateBridge,
  reason = "Scan your fingerprint to register a Trust ID backup",
): Promise<BiometricPayload | null> {
  try {
    const avail = await bridge.getAvailability?.();
    if (avail && avail.available === false) return null;

    const result = await bridge.captureFingerprintTemplate({ reason });
    if (!result?.ok || !result.publicKeyBase64) return null;
    return fingerprintPayloadFromPublicKey(result.publicKeyBase64);
  } catch {
    return null;
  }
}
