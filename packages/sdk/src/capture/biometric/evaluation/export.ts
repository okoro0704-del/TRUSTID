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
  /** Consent rows for every subject in captures (required for collector exports) */
  consentBySubject?: Map<
    string,
    {
      consent_given: true;
      consent_timestamp: string;
      dataset_version: string;
    }
  >;
}): LabeledExportDataset {
  const subjects = [
    ...new Set(input.captures.map((c) => c.subject_id)),
  ].sort();
  const splits =
    input.splitBySubject ?? assignSubjectDisjointSplits(subjects);

  const consentParticipants =
    input.consentBySubject != null
      ? subjects.map((sid) => {
          const c = input.consentBySubject!.get(sid);
          if (!c?.consent_given) {
            throw new Error(
              `Missing consent attestation for subject ${sid} in labeled export`,
            );
          }
          return {
            subject_id: sid,
            consent_given: true as const,
            consent_timestamp: c.consent_timestamp,
            dataset_version: c.dataset_version,
          };
        })
      : undefined;

  return {
    name: input.name ?? EVAL_DATASET_NAME,
    datasetVersion: input.datasetVersion ?? EVAL_DATASET_VERSION,
    modelName: EVAL_PIPELINE_RECORD.modelName,
    modelVersion: EVAL_PIPELINE_RECORD.modelVersion,
    pipelineVersion: EVAL_PIPELINE_RECORD.pipelineVersion,
    embeddingDims: EVAL_PIPELINE_RECORD.embeddingDims,
    ...(consentParticipants
      ? {
          consent_attestation: {
            all_subjects_consented:
              consentParticipants.length === subjects.length,
            participants: consentParticipants,
          },
        }
      : {}),
    samples: input.captures.map((c) => ({
      sampleId: c.sampleId,
      subject_id: c.subject_id,
      identityId: c.subject_id,
      sessionId: c.sessionId,
      split: splits.get(c.subject_id) ?? "development",
      imagePath: c.imagePath,
      imageSha256: c.imageSha256,
      embedding: c.embedding,
      failureModes: c.conditionTags ? [...c.conditionTags] : undefined,
      qualityScore: c.qualityScore,
    })),
  };
}
