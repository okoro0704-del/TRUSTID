# Internal biometric evaluation data collection

```text
This dataset is for biometric evaluation.
It is not a production identity database.
```

```text
INTERNAL BIOMETRIC EVALUATION
NOT FOR PRODUCTION ENROLLMENT
```

## 1. Purpose

Collect **authorized volunteer** face samples through the **same** production ArcFace pipeline so that:

```bash
node scripts/validate-biometric-dataset.mjs --dataset labeled.json
node scripts/run-biometric-benchmark.mjs --dataset labeled.json --out-dir artifacts/biometric-evidence
```

can produce real biometric evidence.

`BIOMETRIC_EVIDENCE_STATUS` remains **`BLOCKED_BY_DATASET`** until actual labeled participant data exists and is benchmarked.

## 2. Internal-only status

- Web UI: `/internal/biometric-eval` (not linked from product nav)
- API: `/internal/biometric-eval/*`
- Gate: env `EVAL_BIOMETRIC_SECRET` + header `x-eval-biometric-secret`
- If secret unset ? API returns **404** (feature invisible)

## 3. Consent

Participants must check an explicit consent box before a `subject_id` is created.

Stored on participant meta and re-exported as `consent_attestation` in `labeled.json`:

```text
consent_given
consent_timestamp
dataset_version
```

Capture APIs refuse participants without consent. Export fails if any sample subject lacks consent meta.

## 4. Participant workflow

1. Unlock with evaluation secret  
2. Consent  
3. Receive random `subject_id` (UUID hex ù not email/phone)  
4. Run Session 1 ? 2 ? 3 (separate sessions, not one continuous stream)  
5. Capture ?3 accepted frames per session via production pipeline  
6. Admin exports `labeled.json`

## 5. Capture protocol

Uses SDK `extractFaceEmbeddingFromImageData` (MediaPipe ? ArcFace align ? `w600k_mbf` ? L2).

Rejected frames return machine-readable reasons, e.g.:

```text
FRAME_REJECTED reason=NO_FACE
FRAME_REJECTED reason=MULTIPLE_FACES
FRAME_REJECTED reason=LOW_QUALITY
```

## 6. Session protocol

| Key | Intent |
|-----|--------|
| `enrollment_neutral` | Normal indoor, neutral face |
| `lighting_and_expression` | Lighting / expression variation |
| `pose_and_distance` | Pose / distance / glasses if applicable |

Each session gets a new `sessionId` (UUID). The collector UI stops and restarts the camera between sessions so capture is not one continuous stream.

## 7. Quality control

Production pipeline quality + multiple-face rejection. No new quality DNN.

## 8. Dataset format

See `DATASET_SPEC.md`. Export root fields include model/pipeline versions and samples with:

`subject_id`, `sessionId`, `sampleId`, `split`, `embedding`, optional `imagePath`.

## 9. Dataset validation

```bash
node scripts/validate-biometric-dataset.mjs --dataset labeled.json
```

Checks required fields, embedding dims, model binding, duplicate ids/hashes, subject-disjoint splits.

## 10. Export procedure

```bash
# Via API (with secret)
POST /internal/biometric-eval/export

# Or offline
node scripts/export-biometric-eval-dataset.mjs
```

Writes `artifacts/biometric-evaluation/exports/labeled.json` (or `TRUSTID_EVAL_DATA_ROOT`).

## 11. Security

- Secret gate; no public listing when disabled  
- No embeddings in API list responses / structured logs  
- Image magic-byte + size limits  
- Path traversal blocked  
- Participant deletion removes subject tree  
- Predictable public URLs are not used for artifacts  

## 12. Retention / deletion

`DELETE /internal/biometric-eval/participants/:subjectId` removes images, embeddings, and session metadata for that subject, deletes any existing `exports/labeled.json`, and refreshes the manifest. Re-export after deletion.

## 13. Benchmark procedure

```bash
node scripts/validate-biometric-dataset.mjs \
  --dataset artifacts/biometric-evaluation/exports/labeled.json

node scripts/run-biometric-benchmark.mjs \
  --dataset artifacts/biometric-evaluation/exports/labeled.json \
  --out-dir artifacts/biometric-evidence \
  --development-split development \
  --test-split test
```

## 14. Known limitations

- `PAD_STATUS = INCOMPLETE` ù active blink is recorded as `active_liveness_check`, not anti-spoof  
- Collection UI does not show similarity scores  
- Evidence stays blocked until real volunteers are collected and benchmarked  
- Does not change ArcFace / thresholds / 1:N architecture  

## Env

```bash
EVAL_BIOMETRIC_SECRET=...
TRUSTID_EVAL_DATA_ROOT=artifacts/biometric-evaluation   # optional
```
