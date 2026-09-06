# TrustID Face Biometric Threshold Policy

## Status

```text
THRESHOLD_STATUS = UNCALIBRATED
BIOMETRIC_EVIDENCE_STATUS = BLOCKED_BY_DATASET
```

No labeled evaluation was available as of 2026-09-06. The numeric operating distance in code remains a **legacy placeholder**, not a measured ArcFace FAR/FRR operating point.

**No calibrated threshold is proposed.**

## Policy record

| Field | Value |
|-------|--------|
| model | `insightface_arcface_w600k_mbf_v1` |
| model_version | `1` |
| pipeline_version | `trustid_face_pipeline_v1` |
| distance_metric | `cosine_distance` (= `1 - cosine_similarity` on L2 unit vectors) |
| threshold | `0.35` (**UNCALIBRATED**) |
| target_FAR | `null` |
| dataset | `null` |
| dataset_version | `null` |
| evaluation_date | `null` |
| number_of_subjects | `0` |
| number_of_genuine_trials | `null` |
| number_of_impostor_trials | `null` |
| status | `UNCALIBRATED` |

Source of truth: `BIOMETRIC_THRESHOLD_POLICY` in `@trustid/shared`.

## Semantics

- **Accept** iff `cosine_distance(probe, template) <= threshold` after exact comparison.
- For **1:N**, apply threshold only after Top-K ANN + exact cosine rerank.
- Lower distance = greater similarity.
- Nearest-neighbor alone is never an accept.

## Production gate (unchanged)

```bash
BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD=true
```

When set, authentication **fails closed** with `BIOMETRIC_THRESHOLD_UNCALIBRATED` until this policy is updated to `CALIBRATED` with labeled evidence.

This gate was **not** weakened for this evidence pass.

## How to calibrate (blocked until dataset exists)

1. Provide a dataset per `DATASET_SPEC.md`.
2. Embed with the exact production pipeline.
3. Run:

```bash
node scripts/run-biometric-benchmark.mjs \
  --dataset labeled.json \
  --out-dir artifacts/biometric-evidence \
  --development-split development \
  --test-split test
```

4. Choose an operating point only from **ESTIMABLE** FAR targets (impostor trials ? 1/FAR).
5. Update this policy with dataset name/version, trial counts, evaluation date, target FAR, and `status: CALIBRATED`.

## Related

- `VALIDATION_REPORT.md`
- `DATASET_SPEC.md`
- `artifacts/biometric-evidence/report.json`
