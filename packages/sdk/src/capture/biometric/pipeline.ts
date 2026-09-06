/**
 * Production face biometric pipeline:
 * frame ? detector ? quality ? PAD ? align ? ArcFace embed
 *
 * Never silently falls back to spatial_fallback_v1.
 */
import {
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  BIOMETRIC_PREPROCESSING_VERSION,
} from "@trustid/shared";
import {
  detectFacesInImageData,
  selectPrimaryFace,
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
  BiometricExtractResult,
  FacePresentationAttackDetector,
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
};

function clearImageData(imageData: ImageData) {
  try {
    imageData.data.fill(0);
  } catch {
    /* ignore */
  }
}

export async function extractFaceEmbeddingFromImageData(
  imageData: ImageData,
  options: FacePipelineOptions = {},
): Promise<BiometricExtractResult> {
  const rejectMultiple = options.rejectMultipleFaces !== false;
  const pad =
    options.pad ??
    (options.allowDevPadBypass
      ? new DevBypassPadDetector()
      : createProductionPadDetector());

  try {
    if (options.preliminaryQualityGate && !options.preliminaryQualityGate(imageData)) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
        message: "Frame failed preliminary quality gate",
      };
    }

    let detection;
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
        code: BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
        message: msg,
      };
    }

    if (detection.faces.length === 0) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.NO_FACE,
        message: "No face detected",
      };
    }
    if (rejectMultiple && detection.faces.length > 1) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.MULTIPLE_FACES,
        message: "Multiple faces detected; ambiguous identity frame",
      };
    }

    const face = selectPrimaryFace(detection.faces)!;
    const quality = assessFaceQuality(imageData, face);
    if (quality.reasons.includes("face_too_small")) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.FACE_TOO_SMALL,
        message: "Face too small for recognition",
      };
    }
    if (!quality.ok) {
      return {
        ok: false,
        code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
        message: `Low face quality: ${quality.reasons.join(",") || "rejected"}`,
      };
    }

    const aligned = alignFaceToArcFace112(imageData, face.landmarks);

    let padResult: import("./types.js").FacePadResult = {
      score: 1,
      decision: "accept",
      modelVersion: "pad_deferred",
      reason: "PAD deferred to caller",
    };

    if (!options.skipPad) {
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
  } finally {
    clearImageData(imageData);
  }
}

export { PRODUCTION_PIPELINE_META };
