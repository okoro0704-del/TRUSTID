import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
} from "@trustid/shared";
import type { MultiModalBiometricPayload } from "./types.js";
import type { SilentWebCaptureResult } from "./silent-camera-web.js";

/**
 * Map a silent-camera result into ambient multimodal payload without collapsing
 * real failure codes into an empty object.
 */
export function multiModalFromSilentCapture(
  web: SilentWebCaptureResult | null | undefined,
  minConfidence: number = BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
): MultiModalBiometricPayload {
  if (!web) {
    return {
      captureErrorCode: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
      captureErrorMessage: "No usable face frame captured",
    };
  }
  if (web.errorCode) {
    return {
      captureErrorCode: web.errorCode,
      captureErrorMessage: web.errorMessage ?? web.errorCode,
    };
  }
  const vector = web.payload?.vector;
  if (
    vector &&
    vector.length === 512 &&
    web.payload.modelName === BIOMETRIC_AI_MODEL_NAME
  ) {
    if (web.confidence < minConfidence) {
      return {
        captureErrorCode: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
        captureErrorMessage: `Face confidence ${web.confidence.toFixed(2)} below ${minConfidence}`,
      };
    }
    return { face: web.payload };
  }
  return {
    captureErrorCode: BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED,
    captureErrorMessage: "No usable face frame captured",
  };
}
