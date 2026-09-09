import { describe, expect, it } from "vitest";
import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_ERROR_CODES,
} from "@trustid/shared";
import { multiModalFromSilentCapture } from "../src/capture/ambient-face-result.js";

describe("multiModalFromSilentCapture", () => {
  it("preserves LIVENESS_FAILED instead of collapsing to empty", () => {
    const result = multiModalFromSilentCapture({
      confidence: 0,
      payload: {
        modality: "face",
        vector: [],
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: 1,
        confidence: 0,
      },
      errorCode: BIOMETRIC_ERROR_CODES.LIVENESS_FAILED,
      errorMessage: "Blink to confirm liveness, then try again",
    });
    expect(result.face).toBeUndefined();
    expect(result.captureErrorCode).toBe(BIOMETRIC_ERROR_CODES.LIVENESS_FAILED);
    expect(result.captureErrorMessage).toMatch(/Blink/i);
  });

  it("preserves BIOMETRIC_MODEL_UNAVAILABLE", () => {
    const result = multiModalFromSilentCapture({
      confidence: 0,
      payload: {
        modality: "face",
        vector: [],
        modelName: "none",
        modelVersion: 0,
        confidence: 0,
      },
      errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
      errorMessage: "ort wasm missing",
    });
    expect(result.captureErrorCode).toBe(
      BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
    );
  });

  it("returns ArcFace face when vector and confidence are valid", () => {
    const vector = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
    const result = multiModalFromSilentCapture({
      confidence: 0.9,
      payload: {
        modality: "face",
        vector,
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: 1,
        confidence: 0.9,
      },
    });
    expect(result.captureErrorCode).toBeUndefined();
    expect(result.face?.vector).toHaveLength(512);
  });

  it("rejects low-confidence ArcFace as LOW_QUALITY", () => {
    const vector = Array.from({ length: 512 }, () => 0.01);
    const result = multiModalFromSilentCapture(
      {
        confidence: 0.2,
        payload: {
          modality: "face",
          vector,
          modelName: BIOMETRIC_AI_MODEL_NAME,
          modelVersion: 1,
          confidence: 0.2,
        },
      },
      0.55,
    );
    expect(result.face).toBeUndefined();
    expect(result.captureErrorCode).toBe(BIOMETRIC_ERROR_CODES.LOW_QUALITY);
  });

  it("maps null capture to FACE_NOT_DETECTED", () => {
    const result = multiModalFromSilentCapture(null);
    expect(result.captureErrorCode).toBe(BIOMETRIC_ERROR_CODES.FACE_NOT_DETECTED);
  });
});
