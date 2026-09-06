/**
 * Evaluation dataset validator + split leakage tests.
 */
import { describe, expect, it } from "vitest";
import {
  assignSubjectDisjointSplits,
  validateLabeledDatasetJson,
} from "../src/capture/biometric/evaluation/validate.js";
import { buildLabeledExport } from "../src/capture/biometric/evaluation/export.js";
import {
  EVAL_PIPELINE_RECORD,
  type EvalCaptureRecord,
} from "../src/capture/biometric/evaluation/protocol.js";
import { parseLabeledDataset } from "../src/capture/biometric/benchmark/dataset.js";

function emb(seed: number) {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed + i * 0.01));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

describe("biometric evaluation dataset", () => {
  it("rejects missing subject_id and bad embeddings", () => {
    const r = validateLabeledDatasetJson({
      modelName: EVAL_PIPELINE_RECORD.modelName,
      modelVersion: EVAL_PIPELINE_RECORD.modelVersion,
      samples: [{ split: "test", embedding: [1, 2, 3] }],
    });
    expect(r.DATASET_VALID).toBe(false);
    expect(r.errors.some((e) => e.code === "MISSING_SUBJECT_ID")).toBe(true);
    expect(r.errors.some((e) => e.code === "BAD_EMBEDDING")).toBe(true);
  });

  it("detects subject split leakage", () => {
    const r = validateLabeledDatasetJson({
      modelName: EVAL_PIPELINE_RECORD.modelName,
      modelVersion: 1,
      samples: [
        {
          subject_id: "aaaaaaaabbbbbbbb",
          sampleId: "1",
          split: "development",
          embedding: emb(1),
        },
        {
          subject_id: "aaaaaaaabbbbbbbb",
          sampleId: "2",
          split: "test",
          embedding: emb(2),
        },
      ],
    });
    expect(r.DATASET_VALID).toBe(false);
    expect(r.errors.some((e) => e.code === "SUBJECT_SPLIT_LEAKAGE")).toBe(true);
  });

  it("assignSubjectDisjointSplits keeps subjects in one split", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const map = assignSubjectDisjointSplits(ids);
    for (const id of ids) {
      expect(map.has(id)).toBe(true);
    }
  });

  it("export is accepted by benchmark parser", () => {
    const captures: EvalCaptureRecord[] = [
      {
        sampleId: "s1",
        subject_id: "subj000000000001",
        sessionId: "sess000000000001",
        sessionKey: "enrollment_neutral",
        captureId: "cap0000000000001",
        timestamp: new Date().toISOString(),
        embedding: emb(3),
        pipeline: EVAL_PIPELINE_RECORD,
      },
      {
        sampleId: "s2",
        subject_id: "subj000000000001",
        sessionId: "sess000000000001",
        sessionKey: "enrollment_neutral",
        captureId: "cap0000000000002",
        timestamp: new Date().toISOString(),
        embedding: emb(4),
        pipeline: EVAL_PIPELINE_RECORD,
      },
      {
        sampleId: "s3",
        subject_id: "subj000000000002",
        sessionId: "sess000000000002",
        sessionKey: "enrollment_neutral",
        captureId: "cap0000000000003",
        timestamp: new Date().toISOString(),
        embedding: emb(5),
        pipeline: EVAL_PIPELINE_RECORD,
      },
    ];
    const labeled = buildLabeledExport({ captures });
    const parsed = parseLabeledDataset(labeled);
    expect(parsed.samples).toHaveLength(3);
    const v = validateLabeledDatasetJson(labeled);
    expect(v.DATASET_VALID).toBe(true);
  });

  it("detects duplicate image hashes", () => {
    const r = validateLabeledDatasetJson({
      modelName: EVAL_PIPELINE_RECORD.modelName,
      modelVersion: 1,
      samples: [
        {
          subject_id: "subj000000000001",
          sampleId: "a",
          split: "development",
          embedding: emb(1),
          imageSha256: "abc",
        },
        {
          subject_id: "subj000000000002",
          sampleId: "b",
          split: "test",
          embedding: emb(2),
          imageSha256: "abc",
        },
      ],
    });
    expect(r.errors.some((e) => e.code === "DUPLICATE_IMAGE_HASH")).toBe(true);
  });
});
