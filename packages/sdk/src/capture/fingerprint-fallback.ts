import type { BiometricPayload } from "../index.js";
import { captureWebFingerprint } from "./web.js";

type WebAuthnFetcher = () => Promise<{
  id: string;
  rawId?: string;
  response?: { authenticatorData?: string; signature?: string };
} | null>;

export type FingerprintFallbackHandlers = {
  /** Native BiometricPrompt / WebAuthn fingerprint capture */
  captureFingerprint?: () => Promise<BiometricPayload | null>;
  runWebAuthn?: WebAuthnFetcher;
};

/**
 * Silent hardware fingerprint fallback when background face capture fails.
 */
export async function promptFingerprintFallback(
  handlers: FingerprintFallbackHandlers = {},
): Promise<BiometricPayload | null> {
  if (handlers.captureFingerprint) {
    try {
      return await handlers.captureFingerprint();
    } catch {
      /* fall through to WebAuthn */
    }
  }

  if (handlers.runWebAuthn) {
    return captureWebFingerprint(handlers.runWebAuthn);
  }

  return null;
}
