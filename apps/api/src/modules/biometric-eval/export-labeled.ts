/**
 * Build labeled.json for the biometric benchmark (DATASET_SPEC compatible).
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_PIPELINE_VERSION,
} from "@trustid/shared";
import {
  EVAL_DATASET_NAME,
  EVAL_DATASET_VERSION,
  type EvalCaptureRecord,
} from "./store.js";

function assignSplits(
  subjectIds: string[],
  seed = 42,
): Map<string, "development" | "validation" | "test"> {
  const ids = [...subjectIds].sort();
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = t;
  }
  const n = ids.length;
  const nDev = Math.max(1, Math.floor(n * 0.5));
  const nVal = Math.max(0, Math.floor(n * 0.2));
  const out = new Map<string, "development" | "validation" | "test">();
  ids.forEach((id, i) => {
    if (i < nDev) out.set(id, "development");
    else if (i < nDev + nVal) out.set(id, "validation");
    else out.set(id, "test");
  });
  if (n >= 2 && ![...out.values()].includes("test")) {
    out.set(ids[n - 1]!, "test");
  }
  return out;
}

export function buildLabeledExportFromCaptures(captures: EvalCaptureRecord[]) {
  const subjects = [...new Set(captures.map((c) => c.subject_id))].sort();
  const splits = assignSplits(subjects);
  return {
    name: EVAL_DATASET_NAME,
    datasetVersion: EVAL_DATASET_VERSION,
    modelName: BIOMETRIC_AI_MODEL_NAME,
    modelVersion: BIOMETRIC_AI_MODEL_VERSION,
    pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
    embeddingDims: BIOMETRIC_AI_EMBEDDING_DIMS,
    samples: captures.map((c) => ({
      sampleId: c.sampleId,
      subject_id: c.subject_id,
      identityId: c.subject_id,
      sessionId: c.sessionId,
      split: splits.get(c.subject_id) ?? "development",
      imagePath: c.imagePath,
      embedding: c.embedding,
      failureModes: c.conditionTags,
      qualityScore: c.qualityScore,
    })),
  };
}
