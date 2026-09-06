import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
} from "@trustid/shared";
import {
  captureNativeFingerprintTemplate,
  captureSilentFaceFromWebCamera,
  captureSilentFaceEnrollmentFromWebCamera,
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
/** Retry until a real face is in frame — never login on an empty camera spin. */
async function captureUnifiedFace(
  signal?: AbortSignal,
): Promise<BiometricPayload | null> {
  for (let i = 0; i < 4; i++) {
    if (signal?.aborted) return null;
    if (i > 0) await delay(250 + i * 150);
    if (signal?.aborted) return null;
    const face = await captureUnifiedFaceOnce(signal);
    if (face) return face;
  }
  return null;
}

async function captureUnifiedFaceOnce(
  signal?: AbortSignal,
): Promise<BiometricPayload | null> {
  const min = BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE;

  try {
    const web = await captureSilentFaceFromWebCamera(undefined, { signal });
    if (web?.errorCode) {
      // Surface model/PAD failures — do not invent a spatial vector
      console.warn("[TrustID] Face capture:", web.errorCode, web.errorMessage);
      return null;
    }
    if (
      web?.payload?.vector &&
      web.payload.vector.length === 512 &&
      web.confidence >= min
    ) {
      return web.payload;
    }
  } catch (err) {
    console.warn(
      "[TrustID] Face capture failed:",
      err instanceof Error ? err.message : err,
    );
  }

  if (signal?.aborted) return null;

  const nativeBridge = getNativeSilentFaceBridge();
  if (nativeBridge) {
    const capturer = createSilentCameraCapturer({ nativeBridge });
    const face = await capturer.captureFaceVector();
    if (
      face?.payload?.vector &&
      face.payload.vector.length === 512 &&
      face.confidence >= min
    ) {
      return face.payload;
    }
  }

  return null;
}

/**
 * Identity-first ambient capture — face is required.
 * Extraction: MediaPipe detect + ArcFace ONNX (512-D). Never spatial fallback.
 * Only the ~2KB embedding is sent — never raw frames.
 */
export async function captureWebAmbientSingleModal(
  _apiFetch?: ApiFetch,
  options?: { signal?: AbortSignal },
): Promise<MultiModalBiometricPayload> {
  const face = await captureUnifiedFace(options?.signal);
  if (face) return { face };
  // Fail closed: empty / no-face frames must not proceed to enroll or match.
  return {};
}

/** Multi-frame enrollment capture for explicit Register Trust ID flow. */
export async function captureWebAmbientEnrollment(
  options?: { signal?: AbortSignal },
): Promise<MultiModalBiometricPayload> {
  if (options?.signal?.aborted) return {};
  const enrolled = await captureSilentFaceEnrollmentFromWebCamera();
  if (enrolled?.errorCode) {
    console.warn(
      "[TrustID] Enrollment capture:",
      enrolled.errorCode,
      enrolled.errorMessage,
    );
    return {};
  }
  if (
    enrolled?.payload?.vector &&
    enrolled.payload.vector.length === 512 &&
    enrolled.payload.modelName === BIOMETRIC_AI_MODEL_NAME
  ) {
    return { face: enrolled.payload };
  }
  if (enrolled?.payload?.modelName) {
    console.warn(
      "[TrustID] Enrollment rejected non-ArcFace model:",
      enrolled.payload.modelName,
      // never log vector
    );
  }
  return {};
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: (opts?: { signal?: AbortSignal }) =>
      captureWebAmbientSingleModal(apiFetch, opts),
    enrollmentPayload: (opts?: { signal?: AbortSignal }) =>
      captureWebAmbientEnrollment(opts),
    captureFingerprintBackup,
    context: () =>
      detectDeviceBiometricContext(undefined, {
        silentFaceAvailable:
          supportsSilentFaceCapture() || Boolean(getNativeSilentFaceBridge()),
      }),
  };
}
