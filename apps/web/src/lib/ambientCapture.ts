import {
  BIOMETRIC_MODALITIES,
  createSilentCameraCapturer,
  detectDeviceBiometricContext,
  supportsSilentFaceCapture,
  type MultiModalBiometricPayload,
  type SilentFaceCaptureBridge,
} from "@trustid/sdk";

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

function isNativeCapacitor(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as Window & {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: Record<string, unknown>;
      registerPlugin?: (name: string) => SilentFaceCaptureBridge;
    };
  }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

function getNativeSilentFaceBridge(): SilentFaceCaptureBridge | undefined {
  if (!isNativeCapacitor()) return undefined;
  const cap = (
    window as Window & {
      Capacitor?: {
        Plugins?: { TrustIdSilentFaceCapture?: SilentFaceCaptureBridge };
        registerPlugin?: (name: string) => SilentFaceCaptureBridge;
      };
    }
  ).Capacitor;

  if (cap?.Plugins?.TrustIdSilentFaceCapture) {
    return cap.Plugins.TrustIdSilentFaceCapture;
  }
  try {
    return cap?.registerPlugin?.("TrustIdSilentFaceCapture");
  } catch {
    return undefined;
  }
}

/**
 * Identity-first ambient capture: cloud biometric only.
 * Does NOT probe device-local passkeys / WebAuthn on boot.
 */
export async function captureWebAmbientSingleModal(
  _apiFetch?: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  const nativeBridge = getNativeSilentFaceBridge();
  const silentFace = Boolean(nativeBridge) || supportsSilentFaceCapture();
  const ctx = detectDeviceBiometricContext(undefined, {
    silentFaceAvailable: silentFace,
  });

  const capturer = createSilentCameraCapturer({
    nativeBridge,
    // No WebAuthn / device-passkey fallback on ambient boot
  });

  try {
    if (ctx.supportsSilentFace || ctx.platform === "android" || nativeBridge) {
      const face = await capturer.captureFaceVector();
      if (face?.payload) return { face: face.payload };
      return {};
    }

    if (ctx.primaryModality === BIOMETRIC_MODALITIES.FACE || silentFace) {
      const face = await capturer.captureFaceVector();
      return face?.payload ? { face: face.payload } : {};
    }

    // Desktop without camera: leave empty — UI will ask for camera / enroll path
    const face = await capturer.captureFaceVector();
    return face?.payload ? { face: face.payload } : {};
  } catch {
    return {};
  }
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: () => captureWebAmbientSingleModal(apiFetch),
    context: () =>
      detectDeviceBiometricContext(undefined, {
        silentFaceAvailable:
          Boolean(getNativeSilentFaceBridge()) || supportsSilentFaceCapture(),
      }),
  };
}
