/**
 * Parse labeled biometric datasets for the evaluation harness.
 *
 * Preferred schema (production-pipeline embeddings):
 * {
 *   "name": "lab_v1",
 *   "modelName": "insightface_arcface_w600k_mbf_v1",
 *   "modelVersion": 1,
 *   "embeddingDims": 512,
 *   "pipelineVersion": "trustid_face_pipeline_v1",
 *   "samples": [
 *     {
 *       "sampleId": "a1",
 *       "subject_id": "person_a",
 *       "split": "test",
 *       "imagePath": "optional/path.jpg",
 *       "sessionId": "optional",
 *       "embedding": [ ... 512 floats from EXACT production pipeline ... ]
 *     }
 *   ]
 * }
 *
 * imagePath/split/session are metadata. Accuracy claims require embeddings
 * from the TrustID production ArcFace pipeline — not other models.
 */

import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
} from "@trustid/shared";
import { l2Normalize } from "../face-align.js";
import type { LabeledBiometricDataset, LabeledSample } from "./types.js";

export function parseLabeledDataset(raw: unknown): LabeledBiometricDataset {
  if (!raw || typeof raw !== "object") {
    throw new Error("Dataset must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const samplesIn = obj.samples;
  if (!Array.isArray(samplesIn) || samplesIn.length === 0) {
    throw new Error("Dataset.samples must be a non-empty array");
  }

  const embeddingDims =
    typeof obj.embeddingDims === "number"
      ? obj.embeddingDims
      : BIOMETRIC_AI_EMBEDDING_DIMS;

  const samples: LabeledSample[] = samplesIn.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`Invalid sample at ${i}`);
    const row = s as Record<string, unknown>;
    const embeddingRaw = row.embedding;
    if (!Array.isArray(embeddingRaw) || embeddingRaw.length !== embeddingDims) {
      throw new Error(
        `Sample ${i} embedding length ${Array.isArray(embeddingRaw) ? embeddingRaw.length : 0}; expected ${embeddingDims}. ` +
          `Embeddings must be produced by the TrustID production ArcFace pipeline (imagePath alone is not sufficient).`,
      );
    }
    const embedding = l2Normalize(embeddingRaw.map(Number));
    const identityId = String(
      row.subject_id ?? row.subjectId ?? row.identityId ?? "",
    );
    return {
      sampleId: String(row.sampleId ?? row.imagePath ?? `s${i}`),
      identityId,
      embedding,
      demographics:
        row.demographics && typeof row.demographics === "object"
          ? (row.demographics as LabeledSample["demographics"])
          : undefined,
      failureModes: Array.isArray(row.failureModes)
        ? (row.failureModes as string[])
        : undefined,
      qualityScore:
        typeof row.qualityScore === "number" ? row.qualityScore : undefined,
      split: typeof row.split === "string" ? row.split : undefined,
      sessionId:
        typeof row.sessionId === "string"
          ? row.sessionId
          : typeof row.session_id === "string"
            ? row.session_id
            : undefined,
      imagePath:
        typeof row.imagePath === "string"
          ? row.imagePath
          : typeof row.image_path === "string"
            ? row.image_path
            : typeof row.path === "string"
              ? row.path
              : undefined,
    };
  });

  for (const s of samples) {
    if (!s.identityId) {
      throw new Error(`Sample ${s.sampleId} missing subject_id/identityId`);
    }
  }

  return {
    name: String(obj.name ?? "unnamed"),
    modelName: String(obj.modelName ?? BIOMETRIC_AI_MODEL_NAME),
    modelVersion:
      typeof obj.modelVersion === "number"
        ? obj.modelVersion
        : BIOMETRIC_AI_MODEL_VERSION,
    embeddingDims,
    samples,
    syntheticPlumbingOnly: obj.syntheticPlumbingOnly === true,
  };
}

/** Tiny synthetic set for unit-testing metric math — never for accuracy claims. */
export function makeSyntheticPlumbingDataset(
  identities = 8,
  shots = 3,
  dims = BIOMETRIC_AI_EMBEDDING_DIMS,
): LabeledBiometricDataset {
  const samples: LabeledSample[] = [];
  for (let i = 0; i < identities; i++) {
    const base = l2Normalize(
      Array.from({ length: dims }, (_, d) => Math.sin(i * 0.7 + d * 0.01)),
    );
    for (let s = 0; s < shots; s++) {
      const noisy = l2Normalize(
        base.map((x, d) => x + 0.02 * Math.sin(s * 3 + d)),
      );
      samples.push({
        sampleId: `id${i}_s${s}`,
        identityId: `id${i}`,
        embedding: noisy,
      });
    }
  }
  return {
    name: "synthetic_plumbing_only",
    modelName: BIOMETRIC_AI_MODEL_NAME,
    modelVersion: BIOMETRIC_AI_MODEL_VERSION,
    embeddingDims: dims,
    samples,
    syntheticPlumbingOnly: true,
  };
}
