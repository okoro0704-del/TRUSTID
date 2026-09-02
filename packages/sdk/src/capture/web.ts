import { BIOMETRIC_AI_EMBEDDING_DIMS, BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { embeddingFromBytes } from "./embedding.js";

type WebAuthnFetcher = () => Promise<{
  id: string;
  rawId?: string;
  response?: { authenticatorData?: string; signature?: string };
} | null>;

function toAiVector(material: string): number[] {
  return embeddingFromBytes(material, BIOMETRIC_AI_EMBEDDING_DIMS);
}

/** PWA fingerprint capture via WebAuthn assertion bytes ? 512-D AI vector. */
export async function captureWebFingerprint(
  runWebAuthn: WebAuthnFetcher,
): Promise<BiometricPayload | null> {
  const assertion = await runWebAuthn();
  if (!assertion) return null;
  const material = [
    assertion.id,
    assertion.rawId ?? "",
    assertion.response?.authenticatorData ?? "",
    assertion.response?.signature ?? "",
  ].join(":");
  const vector = toAiVector(material);
  return {
    modality: BIOMETRIC_MODALITIES.FINGERPRINT,
    vector,
    embedding: vector,
    modelName: "webauthn_proxy_v1",
    modelVersion: 1,
  };
}

/** PWA face proxy — derives 512-D vector from WebAuthn userHandle when present. */
export async function captureWebFaceProxy(
  runWebAuthn: WebAuthnFetcher,
): Promise<BiometricPayload | null> {
  const assertion = await runWebAuthn();
  if (!assertion) return null;
  const handle =
    (assertion.response as { userHandle?: string } | undefined)?.userHandle ??
    assertion.id;
  const vector = toAiVector(handle);
  return {
    modality: BIOMETRIC_MODALITIES.FACE,
    vector,
    embedding: vector,
    modelName: "webauthn_proxy_v1",
    modelVersion: 1,
  };
}
