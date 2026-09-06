# TrustID Face Biometric Threshold Policy

## Status

```text
THRESHOLD_STATUS = UNCALIBRATED
```

The numeric operating distance currently used in code is a **legacy placeholder**, not a measured ArcFace FAR/FRR operating point.

## Policy record

| Field | Value |
|-------|--------|
| model | `insightface_arcface_w600k_mbf_v1` |
| model_version | `1` |
| pipeline_version | `trustid_face_pipeline_v1` |
| distance_metric | `cosine_distance` (= `1 - cosine_similarity` on L2 unit vectors) |
| threshold | `0.35` (**UNCALIBRATED**) |
| target_FAR | `null` — not established |
| dataset | `null` |
| dataset_version | `null` |
| evaluation_date | `null` |
| status | `UNCALIBRATED` |

Source of truth in code: `BIOMETRIC_THRESHOLD_POLICY` in `@trustid/shared`.

## Semantics

- **Accept** iff `cosine_distance(probe, template) <= threshold` after exact comparison.
- For **1:N**, apply threshold only after Top-K ANN + exact cosine rerank.
- Nearest-neighbor alone is never an accept.

## Production gate

Set environment variable:

```bash
BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD=true
```

When set, authentication **fails closed** with `BIOMETRIC_THRESHOLD_UNCALIBRATED` until this policy is updated to `CALIBRATED` with a labeled evaluation.

Default (unset): matching continues with the legacy distance for continuity, but responses/audits carry `thresholdStatus: UNCALIBRATED`.

## How to calibrate (required evidence)

1. Embed a labeled face dataset with the **exact** production pipeline.
2. Run:

```bash
node scripts/run-biometric-benchmark.mjs --dataset labeled.json --out report.json
```

3. Choose an operating point from measured FAR/FRR/TAR tables (e.g. target FAR = 1e-4).
4. Update `BIOMETRIC_THRESHOLD_POLICY` with dataset name/version, evaluation date, target FAR, and set `status: CALIBRATED`.
5. Do **not** invent a threshold that “looks reasonable.”

## Related

- `VALIDATION_REPORT.md` — measured vs unmeasured evidence
- `match-semantics.ts` — 1:1 vs 1:N API semantics
