# Benchmark audit notes (evidence pass)

Audited `scripts/run-biometric-benchmark.mjs` and `packages/sdk/src/capture/biometric/benchmark/*` against scientific requirements.

## Findings fixed (benchmark only)

| Issue | Fix |
|-------|-----|
| Impostor pairs could resample the same pair | Deduplicate by sample-id pair key |
| FAR @ 1e-6 reported without sample-size check | `farEstimability`: require ? 1/FAR impostor trials or `NOT_ESTIMABLE_WITH_CURRENT_SAMPLE_SIZE` |
| Only similarity reported | Also export cosine **distance** (= 1 ? similarity); lower distance = more similar |
| Missing TP/TN/FP/FN/TRR | Added on ROC / rates |
| No uncertainty | Wilson 95% CI when estimable |
| No holdout support | `--development-split` / `--test-split` |
| No machine-readable CSV | `--out-dir` writes CSV + `report.json` |
| No dataset ? silent failure | Default writes `BIOMETRIC_EVIDENCE_STATUS=BLOCKED_BY_DATASET` package |

## Not changed

- Production ArcFace model / recognition path
- Production threshold numeric value (still uncalibrated 0.35)
- `BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD` gate (not weakened)

## Still blocked without labeled data

Embedding generation from images through the live MediaPipe+ONNX stack in Node is **not** wired in this harness (embeddings must be precomputed by the production pipeline and supplied in JSON). That is intentional until a labeled image set exists.
