/**
 * Multi-frame enrollment — quality-filtered frames ? gallery + mean primary.
 * Never averages rejected/low-quality embeddings into the stored template.
 */
import { BIOMETRIC_ERROR_CODES } from "@trustid/shared";
import { meanNormalizeEmbeddings, l2Normalize } from "./face-align.js";
import {
  extractFaceEmbeddingFromImageData,
  type FacePipelineOptions,
} from "./pipeline.js";
import type { AIVectorPayload, BiometricExtractResult } from "./types.js";

export type EnrollmentFrameResult = {
  accepted: AIVectorPayload[];
  rejected: Array<{ code: string; message: string }>;
  primary: AIVectorPayload | null;
  /** Frames dropped as near-duplicates of an already-accepted embedding */
  duplicatesSkipped: number;
};

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Drop near-duplicate frames (sim >= threshold) so mean isn't dominated by
 * the same pose/lighting shot.
 */
export function filterDuplicateEmbeddings(
  payloads: AIVectorPayload[],
  duplicateSimThreshold = 0.995,
): { unique: AIVectorPayload[]; duplicatesSkipped: number } {
  const unique: AIVectorPayload[] = [];
  let duplicatesSkipped = 0;
  for (const p of payloads) {
    const isDup = unique.some(
      (u) => cosineSim(u.vector, p.vector) >= duplicateSimThreshold,
    );
    if (isDup) {
      duplicatesSkipped++;
      continue;
    }
    unique.push(p);
  }
  return { unique, duplicatesSkipped };
}

/**
 * Quality-weighted mean: weight ? confidence, then L2 re-normalize.
 * Frames with confidence below minConfidence are excluded (should already
 * be filtered by the pipeline, but enforced here for safety).
 */
export function qualityWeightedMean(
  payloads: AIVectorPayload[],
  minConfidence = 0.55,
): number[] | null {
  const usable = payloads.filter((p) => (p.confidence ?? 0) >= minConfidence);
  if (!usable.length) return null;
  const dims = usable[0]!.vector.length;
  const acc = new Array<number>(dims).fill(0);
  let wSum = 0;
  for (const p of usable) {
    const w = Math.max(0.01, p.confidence ?? 0.55);
    const v = l2Normalize(p.vector);
    for (let i = 0; i < dims; i++) acc[i]! += v[i]! * w;
    wSum += w;
  }
  for (let i = 0; i < dims; i++) acc[i]! /= wSum;
  return l2Normalize(acc);
}

export async function enrollFromImageFrames(
  frames: ImageData[],
  options: FacePipelineOptions & {
    minAccepted?: number;
    /** Prefer quality-weighted mean over uniform mean when true (default). */
    qualityWeighted?: boolean;
    duplicateSimThreshold?: number;
  } = {},
): Promise<EnrollmentFrameResult> {
  const minAccepted = options.minAccepted ?? 3;
  const acceptedRaw: AIVectorPayload[] = [];
  const rejected: Array<{ code: string; message: string }> = [];

  for (const frame of frames) {
    const result: BiometricExtractResult =
      await extractFaceEmbeddingFromImageData(frame, {
        ...options,
        // Enrollment aggregation owns PAD separately when caller streams frames
      });
    if (result.ok) {
      acceptedRaw.push(result.payload);
    } else {
      rejected.push({ code: result.code, message: result.message });
    }
  }

  const { unique: accepted, duplicatesSkipped } = filterDuplicateEmbeddings(
    acceptedRaw,
    options.duplicateSimThreshold ?? 0.995,
  );

  if (accepted.length < minAccepted) {
    return {
      accepted,
      rejected: [
        ...rejected,
        {
          code: BIOMETRIC_ERROR_CODES.LOW_QUALITY,
          message: `Need at least ${minAccepted} distinct high-quality frames; got ${accepted.length} (duplicates skipped: ${duplicatesSkipped})`,
        },
      ],
      primary: null,
      duplicatesSkipped,
    };
  }

  const useQw = options.qualityWeighted !== false;
  const primaryVector =
    (useQw ? qualityWeightedMean(accepted) : null) ??
    meanNormalizeEmbeddings(accepted.map((a) => a.vector));

  const best = accepted.reduce((a, b) =>
    (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a,
  );

  const primary: AIVectorPayload = {
    ...best,
    vector: primaryVector,
    confidence:
      accepted.reduce((s, a) => s + (a.confidence ?? 0), 0) / accepted.length,
  };

  return { accepted, rejected, primary, duplicatesSkipped };
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
  pipelineVersion?: string;
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
