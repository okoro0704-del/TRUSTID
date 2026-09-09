import {
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
} from "@trustid/shared";
import {
  captureNativeFingerprintTemplate,
  captureSilentFaceFromWebCamera,
  captureSilentFaceEnrollmentFromWebCamera,
  createSilentCameraCapturer,
  detectDeviceBiometricContext,
  multiModalFromSilentCapture,
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

function captureFailure(
  code: string,
  message: string,
): MultiModalBiometricPayload {
  return {
    captureErrorCode: code,
    captureErrorMessage: message,
  };
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

type UnifiedFaceResult =
  | { ok: true; face: BiometricPayload }
  | { ok: false; code: string; message: string };

/**
 * Capture one face vector with the SAME JS model on web, PWA, and APK.
 * Prefer getUserMedia; fall back to native CameraX JPEG → same JS extractor.
 * Preserves the first real failure code (never collapses to empty).
 */
async function captureUnifiedFace(
  signal?: AbortSignal,
): Promise<UnifiedFaceResult> {
  let lastFailure: UnifiedFaceResult = {
    ok: false,
    code: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
    message: "No usable face frame captured",
  };

  for (let i = 0; i < 4; i++) {
    if (signal?.aborted) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
        message: "Capture aborted",
      };
    }
    if (i > 0) await delay(250 + i * 150);
    if (signal?.aborted) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
        message: "Capture aborted",
      };
    }
    const once = await captureUnifiedFaceOnce(signal);
    if (once.ok) return once;
    lastFailure = once;
    // Hard failures should not burn retries (model / camera / auth).
    if (
      once.code === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE ||
      once.code === BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE ||
      once.code === BIOMETRIC_ERROR_CODES.LIVENESS_FAILED ||
      once.code === BIOMETRIC_ERROR_CODES.PAD_UNAVAILABLE
    ) {
      return once;
    }
  }
  return lastFailure;
}

async function captureUnifiedFaceOnce(
  signal?: AbortSignal,
): Promise<UnifiedFaceResult> {
  try {
    const web = await captureSilentFaceFromWebCamera(undefined, { signal });
    const mapped = multiModalFromSilentCapture(
      web,
      BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
    );
    if (mapped.face) return { ok: true, face: mapped.face };
    if (mapped.captureErrorCode) {
      console.warn(
        "[TrustID] Face capture:",
        mapped.captureErrorCode,
        mapped.captureErrorMessage,
      );
      return {
        ok: false,
        code: mapped.captureErrorCode,
        message: mapped.captureErrorMessage ?? mapped.captureErrorCode,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[TrustID] Face capture failed:", msg);
    const code = /permission|NotAllowed|NotFound|getUserMedia|camera/i.test(msg)
      ? BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE
      : /unavailable|integrity|onnx|mediapipe|model/i.test(msg)
        ? BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE
        : BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED;
    return { ok: false, code, message: msg };
  }

  if (signal?.aborted) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
      message: "Capture aborted",
    };
  }

  const nativeBridge = getNativeSilentFaceBridge();
  if (nativeBridge) {
    const capturer = createSilentCameraCapturer({ nativeBridge });
    const face = await capturer.captureFaceVector();
    const mapped = multiModalFromSilentCapture(
      face
        ? {
            confidence: face.confidence,
            payload: face.payload,
          }
        : null,
      BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
    );
    if (mapped.face) return { ok: true, face: mapped.face };
    if (mapped.captureErrorCode) {
      return {
        ok: false,
        code: mapped.captureErrorCode,
        message: mapped.captureErrorMessage ?? mapped.captureErrorCode,
      };
    }
  }

  return {
    ok: false,
    code: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
    message: "No usable face frame captured",
  };
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
  const result = await captureUnifiedFace(options?.signal);
  if (result.ok) return { face: result.face };
  return captureFailure(result.code, result.message);
}

/** Multi-frame enrollment capture for explicit Register Trust ID flow. */
export async function captureWebAmbientEnrollment(
  options?: { signal?: AbortSignal },
): Promise<MultiModalBiometricPayload> {
  if (options?.signal?.aborted) {
    return captureFailure(
      BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
      "Capture aborted",
    );
  }
  try {
    const enrolled = await captureSilentFaceEnrollmentFromWebCamera();
    const mapped = multiModalFromSilentCapture(enrolled);
    if (mapped.face) return mapped;
    if (enrolled?.errorCode) {
      console.warn(
        "[TrustID] Enrollment capture:",
        enrolled.errorCode,
        enrolled.errorMessage,
      );
      if (
        enrolled.errorCode === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE ||
        enrolled.errorCode === BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE
      ) {
        return mapped;
      }
    } else if (enrolled?.payload?.modelName) {
      console.warn(
        "[TrustID] Enrollment rejected non-ArcFace model:",
        enrolled.payload.modelName,
      );
    }
  } catch (err) {
    console.warn(
      "[TrustID] Enrollment capture failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fall back to the same single-frame ArcFace path used for identity scan.
  // Blink/multi-frame enrollment is preferred but must not block Register.
  if (options?.signal?.aborted) {
    return captureFailure(
      BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
      "Capture aborted",
    );
  }
  const result = await captureUnifiedFace(options?.signal);
  if (result.ok) return { face: result.face };
  return captureFailure(result.code, result.message);
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
