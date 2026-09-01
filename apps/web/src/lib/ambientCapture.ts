import {
  BIOMETRIC_MODALITIES,
  captureWebFaceProxy,
  captureWebFingerprint,
  detectDeviceBiometricContext,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import {
  fetchSilentLoginOptions,
  runImmediateSilentPasskey,
} from "@trustid/ui-react";

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Single WebAuthn OS prompt ? one context-aware biometric payload.
 * iOS ? face only, Android/POS ? fingerprint only, kiosk ? first success.
 */
export async function captureWebAmbientSingleModal(
  apiFetch: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  const ctx = detectDeviceBiometricContext();
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

  if (ctx.multiSensor) {
    const face = await captureWebFaceProxy(runOnce);
    if (face) return { face };
    const fingerprint = await captureWebFingerprint(runOnce);
    if (fingerprint) return { fingerprint };
    return {};
  }

  if (ctx.primaryModality === BIOMETRIC_MODALITIES.FACE) {
    const face = await captureWebFaceProxy(runOnce);
    return face ? { face } : {};
  }

  const fingerprint = await captureWebFingerprint(runOnce);
  return fingerprint ? { fingerprint } : {};
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: () => captureWebAmbientSingleModal(apiFetch),
    context: () => detectDeviceBiometricContext(),
  };
}
