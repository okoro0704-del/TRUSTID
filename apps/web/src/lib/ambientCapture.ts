import { BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE } from "@trustid/shared";
import {
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

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
async function captureUnifiedFaceOnce(): Promise<BiometricPayload | null> {
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

/** Retry until a real face is in frame — never login on an empty camera spin. */
async function captureUnifiedFace(): Promise<BiometricPayload | null> {
  for (let i = 0; i < 4; i++) {
    if (i > 0) await delay(250 + i * 150);
    const face = await captureUnifiedFaceOnce();
    if (face) return face;
  }
  return null;
}

/**
 * Identity-first ambient capture — face is required.
 * Extraction runs on-device (ONNX / face-api / spatial); only the ~2KB
 * 512-D float vector is sent to the API — never raw camera frames.
 * Fingerprint is backup enroll only (see registerFingerprintBackup), not a login bypass.
 */
export async function captureWebAmbientSingleModal(
  _apiFetch?: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  const face = await captureUnifiedFace();
  if (face) return { face };
  // Fail closed: empty / no-face frames must not proceed to enroll or match.
  return {};
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: () => captureWebAmbientSingleModal(apiFetch),
    captureFingerprintBackup,
    context: () =>
      detectDeviceBiometricContext(undefined, {
        silentFaceAvailable:
          supportsSilentFaceCapture() || Boolean(getNativeSilentFaceBridge()),
      }),
  };
}
