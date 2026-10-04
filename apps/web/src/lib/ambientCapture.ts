import {
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
  FACE_SCAN_REASON,
  type FaceScanDiagnostics,
  type FaceScanReason,
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
  type FaceScanState,
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
  | { ok: true; face: BiometricPayload; diagnostics?: FaceScanDiagnostics }
  | {
      ok: false;
      code: string;
      message: string;
      reason?: FaceScanReason;
      diagnostics?: FaceScanDiagnostics;
    };

export type FaceCaptureRequest = {
  signal?: AbortSignal;
  onState?: (state: FaceScanState) => void;
};

function aborted(): UnifiedFaceResult {
  return {
    ok: false,
    code: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
    message: "Capture aborted",
    reason: FACE_SCAN_REASON.SCAN_ABORTED,
  };
}

/**
 * Capture one face vector with the SAME JS model on web, PWA, and APK.
 * One scan per attempt: the scan loop already samples many frames and keeps
 * the best. Only a camera that never produced a frame is restarted once.
 */
async function captureUnifiedFace(request: FaceCaptureRequest = {}): Promise<UnifiedFaceResult> {
  const first = await captureUnifiedFaceOnce(request);
  if (first.ok || first.reason !== FACE_SCAN_REASON.NO_VIDEO_FRAME) return first;
  if (request.signal?.aborted) return aborted();
  await delay(400);
  if (request.signal?.aborted) return aborted();
  return captureUnifiedFaceOnce(request);
}

async function captureUnifiedFaceOnce(request: FaceCaptureRequest): Promise<UnifiedFaceResult> {
  const { signal, onState } = request;
  try {
    const web = await captureSilentFaceFromWebCamera(undefined, { signal, onState });
    if (web) {
      const mapped = multiModalFromSilentCapture(web, BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE);
      if (mapped.face) return { ok: true, face: mapped.face, diagnostics: mapped.captureDiagnostics };
      const code = mapped.captureErrorCode ?? BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED;
      console.warn("[TrustID] Face capture:", code, mapped.captureReasonCode ?? "", mapped.captureErrorMessage);
      return {
        ok: false,
        code,
        message: mapped.captureErrorMessage ?? code,
        reason: mapped.captureReasonCode,
        diagnostics: mapped.captureDiagnostics,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[TrustID] Face capture failed:", msg);
    const camera = /permission|NotAllowed|NotFound|getUserMedia|camera/i.test(msg);
    const model = /unavailable|integrity|onnx|mediapipe|model/i.test(msg);
    return {
      ok: false,
      code: camera
        ? BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE
        : model
          ? BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE
          : BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      message: msg,
      reason: camera
        ? FACE_SCAN_REASON.CAMERA_UNAVAILABLE
        : model
          ? FACE_SCAN_REASON.MODELS_NOT_READY
          : FACE_SCAN_REASON.EMBEDDING_FAILED,
    };
  }

  if (signal?.aborted) return aborted();

  // No getUserMedia in this WebView: native CameraX JPEG → same JS extractor.
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
    code: BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE,
    message: "No camera API is available in this browser",
    reason: FACE_SCAN_REASON.CAMERA_UNAVAILABLE,
  };
}

function toPayload(result: UnifiedFaceResult): MultiModalBiometricPayload {
  if (result.ok) return { face: result.face, captureDiagnostics: result.diagnostics };
  return {
    captureErrorCode: result.code,
    captureErrorMessage: result.message,
    captureReasonCode: result.reason,
    captureDiagnostics: result.diagnostics,
  };
}

/**
 * Identity-first ambient capture — face is required.
 * Extraction: MediaPipe detect + ArcFace ONNX (512-D). Never spatial fallback.
 * Only the ~2KB embedding is sent — never raw frames.
 */
export async function captureWebAmbientSingleModal(
  _apiFetch?: ApiFetch,
  options?: FaceCaptureRequest,
): Promise<MultiModalBiometricPayload> {
  return toPayload(await captureUnifiedFace(options));
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
    const enrolled = await captureSilentFaceEnrollmentFromWebCamera(undefined, {
      signal: options?.signal,
    });
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
        enrolled.errorCode === BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE ||
        enrolled.errorCode === BIOMETRIC_ERROR_CODES.DETECTOR_ERROR ||
        enrolled.reasonCode === FACE_SCAN_REASON.SCAN_ABORTED
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
  return toPayload(await captureUnifiedFace({ signal: options?.signal }));
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: (opts?: FaceCaptureRequest) => captureWebAmbientSingleModal(apiFetch, opts),
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
