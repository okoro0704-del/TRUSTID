import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { embeddingFromBytes } from "./embedding.js";

type WebAuthnFetcher = () => Promise<{
  id: string;
  rawId?: string;
  response?: { authenticatorData?: string; signature?: string };
} | null>;

/**
 * PWA fingerprint capture via WebAuthn assertion bytes.
 * OS biometric sheet is the only UI — no Trust ID forms.
 */
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
  return {
    modality: BIOMETRIC_MODALITIES.FINGERPRINT,
    embedding: embeddingFromBytes(material, 32),
  };
}

/**
 * PWA face proxy — derives embedding from WebAuthn userHandle when present.
 * Native apps should override with real liveness-verified face vectors.
 */
export async function captureWebFaceProxy(
  runWebAuthn: WebAuthnFetcher,
): Promise<BiometricPayload | null> {
  const assertion = await runWebAuthn();
  if (!assertion) return null;
  const handle =
    (assertion.response as { userHandle?: string } | undefined)?.userHandle ??
    assertion.id;
  return {
    modality: BIOMETRIC_MODALITIES.FACE,
    embedding: embeddingFromBytes(handle, 32),
  };
}
