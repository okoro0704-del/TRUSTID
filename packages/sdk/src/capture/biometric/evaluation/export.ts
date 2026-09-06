/**
 * Build benchmark-compatible labeled.json from evaluation capture records.
 */
import {
  assignSubjectDisjointSplits,
} from "./validate.js";
import {
  EVAL_DATASET_NAME,
  EVAL_DATASET_VERSION,
  EVAL_PIPELINE_RECORD,
  type EvalCaptureRecord,
  type LabeledExportDataset,
} from "./protocol.js";

export function buildLabeledExport(input: {
  captures: EvalCaptureRecord[];
  datasetVersion?: string;
  name?: string;
  /** Optional fixed split map; otherwise subject-disjoint auto assignment */
  splitBySubject?: Map<string, "development" | "validation" | "test">;
}): LabeledExportDataset {
  const subjects = [
    ...new Set(input.captures.map((c) => c.subject_id)),
  ].sort();
  const splits =
    input.splitBySubject ?? assignSubjectDisjointSplits(subjects);

  return {
    name: input.name ?? EVAL_DATASET_NAME,
    datasetVersion: input.datasetVersion ?? EVAL_DATASET_VERSION,
    modelName: EVAL_PIPELINE_RECORD.modelName,
    modelVersion: EVAL_PIPELINE_RECORD.modelVersion,
    pipelineVersion: EVAL_PIPELINE_RECORD.pipelineVersion,
    embeddingDims: EVAL_PIPELINE_RECORD.embeddingDims,
    samples: input.captures.map((c) => ({
      sampleId: c.sampleId,
      subject_id: c.subject_id,
      identityId: c.subject_id,
      sessionId: c.sessionId,
      split: splits.get(c.subject_id) ?? "development",
      imagePath: c.imagePath,
      embedding: c.embedding,
      failureModes: c.conditionTags ? [...c.conditionTags] : undefined,
      qualityScore: c.qualityScore,
    })),
  };
}
