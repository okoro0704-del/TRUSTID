import { BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE } from "@trustid/shared";
import {
  BIOMETRIC_MODALITIES,
  captureNativeFingerprintTemplate,
  captureSilentFaceFromWebCamera,
  createSilentCameraCapturer,
  detectDeviceBiometricContext,
  supportsSilentFaceCapture,
  type BiometricPayload,
  type FingerprintTemplateBridge,
  type MultiModalBiometricPayload,
  type SilentFaceCaptureBridge,
} from "@trustid/sdk";

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
  registerPlugin?: (name: string) => unknown;
};

function getCap(): CapacitorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
}

function getPlugin<T>(name: string): T | undefined {
  const cap = getCap();
  if (!cap?.isNativePlatform?.()) return undefined;
  if (cap.Plugins?.[name]) return cap.Plugins[name] as T;
  try {
    return cap.registerPlugin?.(name) as T;
  } catch {
    return undefined;
  }
}

function getNativeSilentFaceBridge(): SilentFaceCaptureBridge | undefined {
  return getPlugin<SilentFaceCaptureBridge>("TrustIdSilentFaceCapture");
}

function getFingerprintBridge(): FingerprintTemplateBridge | undefined {
  return getPlugin<FingerprintTemplateBridge>("TrustIdBiometricGate");
}

/** Prompt fingerprint and return a cloud-registry fingerprint payload. */
export async function captureFingerprintBackup(
  reason?: string,
): Promise<BiometricPayload | null> {
  const bridge = getFingerprintBridge();
  if (!bridge?.captureFingerprintTemplate) return null;
  return captureNativeFingerprintTemplate(
    bridge,
    reason ?? "Scan your fingerprint for Trust ID backup",
  );
}

/**
 * Capture one face vector with the SAME JS model on web, PWA, and APK.
 * Prefer getUserMedia; fall back to native CameraX JPEG → same JS extractor.
 */
async function captureUnifiedFace(): Promise<BiometricPayload | null> {
  const min = BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE;

  try {
    const web = await captureSilentFaceFromWebCamera();
    if (web?.payload?.vector && web.confidence >= min) {
      return web.payload;
    }
  } catch {
    /* try native */
  }

  const nativeBridge = getNativeSilentFaceBridge();
  if (nativeBridge) {
    const capturer = createSilentCameraCapturer({ nativeBridge });
    const face = await capturer.captureFaceVector();
    if (face?.payload?.vector && face.confidence >= min) {
      return face.payload;
    }
  }

  return null;
}

/**
 * Identity-first ambient capture — one shared face model across all clients.
 * Fingerprint is backup only when face cannot be captured.
 */
export async function captureWebAmbientSingleModal(
  _apiFetch?: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  try {
    const face = await captureUnifiedFace();
    if (face) return { face };

    const fingerprint = await captureFingerprintBackup(
      "Face not available — scan fingerprint for Trust ID",
    );
    return fingerprint ? { fingerprint } : {};
  } catch {
    try {
      const fingerprint = await captureFingerprintBackup(
        "Scan fingerprint for Trust ID",
      );
      return fingerprint ? { fingerprint } : {};
    } catch {
      return {};
    }
  }
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: () => captureWebAmbientSingleModal(apiFetch),
    captureFingerprintBackup,
    context: () =>
      detectDeviceBiometricContext(undefined, {
        silentFaceAvailable:
          Boolean(getNativeSilentFaceBridge()) || supportsSilentFaceCapture(),
      }),
  };
}

export { BIOMETRIC_MODALITIES };
