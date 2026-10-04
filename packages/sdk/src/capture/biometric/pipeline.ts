/**
 * Production face biometric pipeline:
 * frame → detector → quality → PAD → align → ArcFace embed
 *
 * Never silently falls back to spatial_fallback_v1.
 */
import {
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  BIOMETRIC_PREPROCESSING_VERSION,
  FACE_SCAN_REASON,
  type FaceScanReason,
} from "@trustid/shared";
import {
  detectFacesInImageData,
  selectPrimaryFace,
  type DetectionResult,
} from "./detector-mediapipe.js";
import { alignFaceToArcFace112 } from "./face-align.js";
import { assessFaceQuality } from "./face-quality.js";
import {
  createProductionPadDetector,
  DevBypassPadDetector,
} from "./pad.js";
import { embedAlignedFace112 } from "./recognizer-arcface.js";
import type {
  AIVectorPayload,
  BiometricExtractError,
  BiometricExtractResult,
  DetectedFace,
  FacePadResult,
  FacePresentationAttackDetector,
  FaceQualityResult,
} from "./types.js";
import { PRODUCTION_PIPELINE_META } from "./types.js";

export type FacePipelineOptions = {
  modelBaseUrl?: string;
  /** Reject frames with >1 face (identity login default). */
  rejectMultipleFaces?: boolean;
  /**
   * DEV/TEST only. Never enable in production builds.
   * When true, uses DevBypassPadDetector.
   */
  allowDevPadBypass?: boolean;
  pad?: FacePresentationAttackDetector;
  /** Skip PAD stage (caller must enforce PAD before using the embedding). */
  skipPad?: boolean;
  /** Optional pre-gate (NOT identity detection). */
  preliminaryQualityGate?: (imageData: ImageData) => boolean;
  /** Detection already computed for this exact frame (avoids a second detect). */
  detection?: DetectionResult;
};

export type FaceCandidate = {
  ok: true;
  face: DetectedFace;
  quality: FaceQualityResult;
};

function qualityRejection(quality: FaceQualityResult): BiometricExtractError {
  const r = quality.reasons;
  // Only extreme_pose, poor_exposure and blur_or_flat can fail the gate on
  // their own; blur is the remaining case.
  const reason: FaceScanReason = r.includes("extreme_pose")
    ? FACE_SCAN_REASON.POSE_REJECTED
    : r.includes("poor_exposure")
      ? quality.exposure === "bright"
        ? FACE_SCAN_REASON.OVEREXPOSED
        : FACE_SCAN_REASON.LOW_LIGHT
      : FACE_SCAN_REASON.EXCESSIVE_BLUR;
  return {
    ok: false,
    code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
    reason,
    message: `Low face quality: ${r.join(",") || "rejected"}`,
  };
}

function clearImageData(imageData: ImageData) {
  try {
    imageData.data.fill(0);
  } catch {
    /* ignore */
  }
}

/**
 * Face-count, geometry and photometric gates for one detected frame.
 * Synchronous; does not touch the embedder.
 */
export function evaluateFaceCandidate(
  imageData: ImageData,
  detection: DetectionResult,
  options: Pick<FacePipelineOptions, "rejectMultipleFaces"> = {},
): FaceCandidate | BiometricExtractError {
  const rejectMultiple = options.rejectMultipleFaces !== false;
  if (detection.faces.length === 0) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.NO_FACE,
      reason: FACE_SCAN_REASON.NO_FACE_DETECTED,
      message: "No face detected",
    };
  }
  if (rejectMultiple && detection.faces.length > 1) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.MULTIPLE_FACES,
      reason: FACE_SCAN_REASON.MULTIPLE_FACES,
      message: "Multiple faces detected; ambiguous identity frame",
    };
  }

  const face = selectPrimaryFace(detection.faces)!;
  const quality = assessFaceQuality(imageData, face);
  if (quality.reasons.includes("face_too_small")) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.FACE_TOO_SMALL,
      reason: FACE_SCAN_REASON.FACE_TOO_SMALL,
      message: "Face too small for recognition",
    };
  }
  if (face.landmarksInFrame === false) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
      reason: FACE_SCAN_REASON.FACE_OUT_OF_BOUNDS,
      message: "Face is partly outside the camera frame",
    };
  }
  if (!quality.ok) {
    return qualityRejection(quality);
  }
  return { ok: true, face, quality };
}

/**
 * Align → (optional PAD) → ArcFace for a candidate that passed the gates.
 */
export async function embedFaceCandidate(
  imageData: ImageData,
  candidate: FaceCandidate,
  options: FacePipelineOptions = {},
): Promise<BiometricExtractResult> {
  const { face, quality } = candidate;

  let aligned: Float32Array;
  try {
    aligned = alignFaceToArcFace112(imageData, face.landmarks);
  } catch (err) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      reason: FACE_SCAN_REASON.FACE_CROP_FAILED,
      message: err instanceof Error ? err.message : "Face alignment failed",
    };
  }
  if (aligned.some((v) => !Number.isFinite(v))) {
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      reason: FACE_SCAN_REASON.FACE_CROP_FAILED,
      message: "Face alignment produced a non-finite crop",
    };
  }

  let padResult: FacePadResult = {
    score: 1,
    decision: "accept",
    modelVersion: "pad_deferred",
    reason: "PAD deferred to caller",
  };

  if (!options.skipPad) {
    const pad =
      options.pad ??
      (options.allowDevPadBypass
        ? new DevBypassPadDetector()
        : createProductionPadDetector());
    padResult = await pad.evaluate({
      imageData,
      face,
      alignedRgb112: aligned,
    });

    if (padResult.decision !== "accept") {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.LIVENESS_FAILED,
        message:
          padResult.decision === "unavailable"
            ? padResult.reason
            : `Liveness/PAD failed: ${padResult.reason}`,
      };
    }
  }

  let embed;
  try {
    embed = await embedAlignedFace112(aligned, options.modelBaseUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Embedding failed";
    if (/unavailable|integrity|missing|onnx/i.test(msg)) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
        message: msg,
      };
    }
    return {
      ok: false,
      code: BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      reason: FACE_SCAN_REASON.EMBEDDING_FAILED,
      message: msg,
    };
  }

  const payload: AIVectorPayload = {
    modality: BIOMETRIC_MODALITIES.FACE,
    vector: embed.vector,
    modelName: embed.modelName,
    modelVersion: embed.modelVersion,
    confidence: Math.min(face.confidence, quality.score),
    detectorVersion: BIOMETRIC_DETECTOR_VERSION,
    alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
    preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
    padScore: padResult.score,
    padModelVersion: padResult.modelVersion,
  };

  return { ok: true, payload, face, quality, pad: padResult };
}

export async function extractFaceEmbeddingFromImageData(
  imageData: ImageData,
  options: FacePipelineOptions = {},
): Promise<BiometricExtractResult> {
  try {
    if (options.preliminaryQualityGate && !options.preliminaryQualityGate(imageData)) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
        message: "Frame failed preliminary quality gate",
      };
    }

    let detection = options.detection;
    if (!detection) {
      try {
        detection = await detectFacesInImageData(
          imageData,
          options.modelBaseUrl,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Detector failed";
        if (/unavailable|integrity|missing/i.test(msg)) {
          return {
            ok: false,
            code: BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
            message: msg,
          };
        }
        return {
          ok: false,
          code: BIOMETRIC_ERROR_CODES.DETECTOR_ERROR,
          reason: FACE_SCAN_REASON.DETECTOR_ERROR,
          message: msg,
        };
      }
    }

    const candidate = evaluateFaceCandidate(imageData, detection, options);
    if (!candidate.ok) return candidate;
    return await embedFaceCandidate(imageData, candidate, options);
  } finally {
    clearImageData(imageData);
  }
}

export { PRODUCTION_PIPELINE_META };
