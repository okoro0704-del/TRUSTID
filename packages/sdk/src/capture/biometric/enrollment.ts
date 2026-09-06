/**
 * Multi-frame enrollment — several high-quality live frames ? gallery + primary.
 * Primary = re-normalized mean of L2-normalized ArcFace embeddings (standard multi-shot).
 */
import { BIOMETRIC_ERROR_CODES } from "@trustid/shared";
import { meanNormalizeEmbeddings } from "./face-align.js";
import {
  extractFaceEmbeddingFromImageData,
  type FacePipelineOptions,
} from "./pipeline.js";
import type { AIVectorPayload, BiometricExtractResult } from "./types.js";

export type EnrollmentFrameResult = {
  accepted: AIVectorPayload[];
  rejected: Array<{ code: string; message: string }>;
  primary: AIVectorPayload | null;
};

export async function enrollFromImageFrames(
  frames: ImageData[],
  options: FacePipelineOptions & { minAccepted?: number } = {},
): Promise<EnrollmentFrameResult> {
  const minAccepted = options.minAccepted ?? 3;
  const accepted: AIVectorPayload[] = [];
  const rejected: Array<{ code: string; message: string }> = [];

  for (const frame of frames) {
    const result: BiometricExtractResult =
      await extractFaceEmbeddingFromImageData(frame, options);
    if (result.ok) {
      accepted.push(result.payload);
    } else {
      rejected.push({ code: result.code, message: result.message });
    }
  }

  if (accepted.length < minAccepted) {
    return {
      accepted,
      rejected: [
        ...rejected,
        {
          code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
          message: `Need at least ${minAccepted} high-quality frames; got ${accepted.length}`,
        },
      ],
      primary: null,
    };
  }

  const vectors = accepted.map((a) => a.vector);
  const primaryVector = meanNormalizeEmbeddings(vectors);
  const best = accepted.reduce((a, b) =>
    (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a,
  );

  const primary: AIVectorPayload = {
    ...best,
    vector: primaryVector,
    confidence: accepted.reduce((s, a) => s + (a.confidence ?? 0), 0) / accepted.length,
  };

  return { accepted, rejected, primary };
}

/** JSON envelope for multi-template storage alongside primary pgvector column */
export type FaceTemplateEnvelope = {
  schema: "trustid_face_template_v1";
  primary: number[];
  gallery: number[][];
  modelName: string;
  modelVersion: number;
  detectorVersion?: string;
  alignmentVersion?: string;
  preprocessingVersion?: string;
};

export function buildFaceTemplateEnvelope(
  primary: AIVectorPayload,
  gallery: AIVectorPayload[],
): FaceTemplateEnvelope {
  return {
    schema: "trustid_face_template_v1",
    primary: primary.vector,
    gallery: gallery.map((g) => g.vector),
    modelName: primary.modelName,
    modelVersion: primary.modelVersion,
    detectorVersion: primary.detectorVersion,
    alignmentVersion: primary.alignmentVersion,
    preprocessingVersion: primary.preprocessingVersion,
  };
}

export function parseFaceTemplateEnvelope(
  embeddingJson: string,
): FaceTemplateEnvelope | { primary: number[]; legacy: true; modelName?: string } {
  try {
    const parsed = JSON.parse(embeddingJson) as unknown;
    if (Array.isArray(parsed)) {
      return { primary: parsed as number[], legacy: true };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "schema" in parsed &&
      (parsed as FaceTemplateEnvelope).schema === "trustid_face_template_v1"
    ) {
      return parsed as FaceTemplateEnvelope;
    }
    if (parsed && typeof parsed === "object" && "primary" in parsed) {
      return parsed as FaceTemplateEnvelope;
    }
  } catch {
    /* fall through */
  }
  return { primary: [], legacy: true };
}
