import {
  BIOMETRIC_MODALITIES,
  captureWebFingerprint,
  captureWebFaceProxy,
  createSilentCameraCapturer,
  detectDeviceBiometricContext,
  supportsSilentFaceCapture,
  type MultiModalBiometricPayload,
} from "@trustid/sdk";
import {
  fetchSilentLoginOptions,
  runImmediateSilentPasskey,
} from "@trustid/ui-react";

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Ambient single-modality capture with silent background face on Android/PWA.
 * Falls back to hardware fingerprint when face confidence is low or camera blocked.
 */
export async function captureWebAmbientSingleModal(
  apiFetch: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  const silentFace = supportsSilentFaceCapture();
  const ctx = detectDeviceBiometricContext(undefined, { silentFaceAvailable: silentFace });

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

  const capturer = createSilentCameraCapturer({
    runWebAuthn: runOnce,
    captureFingerprint: () => captureWebFingerprint(runOnce),
  });

  if (ctx.supportsSilentFace || ctx.platform === "android") {
    const face = await capturer.captureWithFallback();
    if (face?.modality === BIOMETRIC_MODALITIES.FACE) return { face };
    if (face?.modality === BIOMETRIC_MODALITIES.FINGERPRINT) return { fingerprint: face };
  }

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
    context: () =>
      detectDeviceBiometricContext(undefined, {
        silentFaceAvailable: supportsSilentFaceCapture(),
      }),
  };
}
