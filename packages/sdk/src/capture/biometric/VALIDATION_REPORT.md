# ArcFace Pipeline Scientific Validation Report

**Baseline commit:** `7f8d197`  
**Evidence date:** 2026-09-06  
**Evidence package:** `artifacts/biometric-evidence/`

---

## EXECUTIVE SUMMARY

```text
BIOMETRIC_EVIDENCE_STATUS = BLOCKED_BY_DATASET
```

The production ArcFace pipeline and fail-closed search hardening remain structurally validated. **No labeled face dataset** with subject IDs and production-pipeline embeddings is available in this repository or evidence environment. Therefore **no biometric accuracy, threshold calibration, Rank-N, or PAD anti-spoof metrics are reported.**

Synthetic plumbing and Node brute-force ANN timings are **not** biometric accuracy.

---

## PIPELINE — PASS (prior MEASURED)

```text
capture ? MediaPipe ? 5-pt align ? 112×112 RGB NCHW ? (x-127.5)/128
? w600k_mbf ? 512-D ? L2 ? cosine distance
```

Lower cosine **distance** = greater similarity (`distance = 1 - similarity`).

## MODEL — PASS (prior MEASURED)

| Property | Value |
|----------|--------|
| Input | `input.1` `[1,3,112,112]` float32 |
| Output | `[1,512]` float32 |
| App L2 | yes |
| Projection | none |

---

## DATASET

| Item | Value |
|------|--------|
| Dataset used | **none** |
| Subjects | **0** |
| Images | **0** |
| Genuine trials | **NOT MEASURED** |
| Impostor trials | **NOT MEASURED** |

See `DATASET_SPEC.md` for the exact required schema and FAR sample-size table.

## DATASET LIMITATIONS

- No `subject_id` + image/`embedding` corpus checked in
- No development/test subject-disjoint splits available
- Cannot estimate FAR at 1e-2…1e-6
- Cannot calibrate `0.35`

---

## 1:1 VERIFICATION

| Metric | Status |
|--------|--------|
| FAR / FRR / TAR / TRR / ROC / EER | **NOT MEASURED** |
| Genuine / impostor score distributions | **NOT MEASURED** |
| Operating points FAR 1e-2…1e-6 | **NOT ESTIMABLE** (no trials) |

## THRESHOLD CALIBRATION

| Item | Value |
|------|--------|
| Current threshold | cosine distance **0.35** (legacy placeholder) |
| FAR @ 0.35 | **NOT MEASURED** |
| FRR @ 0.35 | **NOT MEASURED** |
| TAR @ 0.35 | **NOT MEASURED** |
| Proposed calibrated threshold | **none** |
| **THRESHOLD_STATUS** | **UNCALIBRATED** |

`BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD` gate is **unchanged** (not weakened).

## 1:N IDENTIFICATION

| Metric | Status |
|--------|--------|
| Rank-1 / 5 / 10 | **NOT MEASURED** |
| FPIR / FNIR | **NOT MEASURED** |
| Candidate recall @ K=10/50/100 | **NOT MEASURED** |

Architecture (implemented, not accuracy-proven): Top-K ? exact rerank ? threshold ? identity/`NO_MATCH`.

## SEARCH INFRASTRUCTURE

| Item | Status |
|------|--------|
| Node brute-force synthetic (prior) | infra-only; **not** recognition accuracy |
| Live ANN recall vs exact | **NOT MEASURED** |
| Latency p50/p95/p99 (identify stages) | **NOT MEASURED** (no labeled probes) |

## PGVECTOR

```text
status = ENVIRONMENT_BLOCKED
reason = DATABASE_URL unavailable
```

```bash
DATABASE_URL=postgres://... node scripts/run-pgvector-hnsw-benchmark.mjs \
  --sizes 10000,100000,1000000 --top-k 10,50,100
```

## MULTI-FRAME ENROLLMENT

Implementation exists (`captureSilentFaceEnrollmentFromWebCamera`, quality-weighted mean).  
Accuracy delta vs single-frame: **NOT MEASURED**.

## PAD

```text
PAD_STATUS = INCOMPLETE
```

Blink = active liveness only. **Not** print/replay/mask/deepfake PAD. No fabricated PAD metrics.

## SECURITY

| Control | Status |
|---------|--------|
| Full-gallery Node fallback | **REMOVED** — fail closed |
| Regression `vector-matcher-fail-closed.test.ts` | **PASS** (executed 2026-09-06) |
| Threshold calibrated | **NO** |

## LIMITATIONS

1. Blocked by missing labeled dataset  
2. Uncalibrated threshold  
3. Incomplete PAD  
4. No live pgvector evidence in this environment  
5. 10B architecture **not** justified  

## BENCHMARK CHANGES (this evidence pass)

Audit fixes (benchmark only — not production recognition):

1. Deduplicate impostor pair sampling  
2. Report TP/TN/FP/FN, TRR, cosine **distance** alongside similarity  
3. FAR target estimability gate (`NOT_ESTIMABLE_WITH_CURRENT_SAMPLE_SIZE` when impostor trials < 1/FAR)  
4. Wilson 95% CI when estimable  
5. Optional development/test split evaluation  
6. CSV + `report.json` evidence export under `--out-dir`  
7. Default no-dataset path writes `BLOCKED_BY_DATASET` evidence package  

---

## FINAL STATUS

```text
PIPELINE_STATUS              PASS
MODEL_STATUS                 PASS
BIOMETRIC_ACCURACY_STATUS    UNMEASURED
THRESHOLD_STATUS             UNCALIBRATED
PAD_STATUS                   INCOMPLETE
SEARCH_STATUS                PARTIAL
SECURITY_STATUS              PARTIAL
10B_READINESS_STATUS         BLOCKED
BIOMETRIC_EVIDENCE_STATUS    BLOCKED_BY_DATASET
```

### MEASURED_FACTS
- Pipeline/model I/O (prior)
- Fail-closed ANN path + regression PASS

### UNMEASURED_ITEMS
- All labeled FAR/FRR/EER/TAR/Rank-N/PAD accuracy metrics

### DATASET_LIMITATIONS
- No compliant labeled corpus present

### SECURITY_LIMITATIONS
- Uncalibrated threshold; incomplete PAD

### REMAINING_BLOCKERS
1. Labeled production-pipeline dataset (`DATASET_SPEC.md`)
2. Threshold calibration from measured operating points
3. Live pgvector HNSW with `DATABASE_URL`
4. Validated PAD evaluation

### Sufficient to proceed to 10B architecture design?

**NO.**
