import {
  captureWebFaceProxy,
  captureWebFingerprint,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import {
  fetchSilentLoginOptions,
  runImmediateSilentPasskey,
} from "@trustid/ui-react";

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Single WebAuthn OS prompt ? dual face + fingerprint embeddings.
 * Avoids double biometric sheets on PWA boot.
 */
export async function captureWebAmbientMultiModal(
  apiFetch: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  let cached: Awaited<ReturnType<typeof runImmediateSilentPasskey>> | null = null;

  const runOnce = async () => {
    if (cached) return cached;
    try {
      const options = await fetchSilentLoginOptions(apiFetch);
      cached = await runImmediateSilentPasskey(options);
      return cached;
    } catch {
      return null;
    }
  };

  const [face, fingerprint] = await Promise.all([
    captureWebFaceProxy(runOnce),
    captureWebFingerprint(runOnce),
  ]);

  const payload: MultiModalBiometricPayload = {};
  if (face) payload.face = face;
  if (fingerprint) payload.fingerprint = fingerprint;
  return payload;
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: () => captureWebAmbientMultiModal(apiFetch),
  };
}
