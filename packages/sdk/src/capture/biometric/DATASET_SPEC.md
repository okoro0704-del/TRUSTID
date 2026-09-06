# Required labeled biometric dataset specification

**Status:** No compliant dataset is present in this repository or evidence environment.

```text
BIOMETRIC_EVIDENCE_STATUS = BLOCKED_BY_DATASET
```

## Minimum schema

Each row / sample must provide:

| Field | Required | Description |
|-------|----------|-------------|
| `subject_id` | **yes** | Stable identity label (alias: `identityId`) |
| `imagePath` or `path` | **yes** for image datasets | Path to face image |
| `split` | **yes** for calibration | `development` / `validation` / `test` (subject-disjoint) |
| `embedding` | **yes** for JSON harness | 512-D float vector from **exact** Trust ID production pipeline |
| `sessionId` | recommended | Capture session grouping |
| `sampleId` | recommended | Unique sample id |

Optional (only if ground-truth exists — never inferred):

- `failureModes[]` (pose, blur, lighting, glasses, occlusion, …)
- quality metadata

## Pipeline binding (mandatory for accuracy claims)

Embeddings must be produced by:

```text
capture ? MediaPipe ? 5-pt ArcFace align ? 112×112 RGB NCHW
? (x-127.5)/128 ? InsightFace w600k_mbf ? 512-D ? L2
```

Record on the dataset root:

```json
{
  "name": "trustid_lab_v1",
  "datasetVersion": "1.0.0",
  "modelName": "insightface_arcface_w600k_mbf_v1",
  "modelVersion": 1,
  "pipelineVersion": "trustid_face_pipeline_v1",
  "embeddingDims": 512,
  "samples": [ ... ]
}
```

## Recommended scale (for meaningful FAR)

| Target FAR | Minimum impostor trials (zero-failure rule) |
|------------|-----------------------------------------------|
| 1e-2 | ? 100 |
| 1e-3 | ? 1,000 |
| 1e-4 | ? 10,000 |
| 1e-5 | ? 100,000 |
| 1e-6 | ? 1,000,000 |

Prefer **subject-disjoint** development vs test splits for threshold selection.

## Forbidden

- Fabricated / random labels
- Scraped unlabeled internet faces presented as identities
- Embeddings from other models claimed as Trust ID accuracy
- Demographic inference from faces

## How to run once data exists

```bash
node scripts/run-biometric-benchmark.mjs \
  --dataset path/to/labeled.json \
  --out-dir artifacts/biometric-evidence \
  --development-split development \
  --test-split test
```
