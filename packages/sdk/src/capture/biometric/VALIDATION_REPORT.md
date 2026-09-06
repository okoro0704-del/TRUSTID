# ArcFace Pipeline Scientific Validation Report

**Commits:** `7a4fb8c` (pipeline) · `56fa5f3` (envelope fix) · hardening phase (fail-closed + Top-K)  
**Updated:** 2026-09-06  
**Scope:** Harden existing implementation. No 10B redesign. No invented accuracy/PAD metrics.

---

## Executive status

| Key | Status |
|-----|--------|
| **PIPELINE_STATUS** | `PASS` |
| **MODEL_STATUS** | `PASS` (I/O measured) |
| **BIOMETRIC_ACCURACY_STATUS** | `UNMEASURED` |
| **THRESHOLD_STATUS** | `UNCALIBRATED` |
| **PAD_STATUS** | `INCOMPLETE` |
| **SEARCH_STATUS** | `PARTIAL` (Top-K+rerank implemented; live HNSW scale `NOT_RUN` without DATABASE_URL) |
| **SECURITY_STATUS** | `PARTIAL` (full-gallery fallback removed; see security section) |
| **10B_READINESS_STATUS** | `BLOCKED` |

Evidence tags used below: **MEASURED** · **INFERRED** · **NOT MEASURED** · **NOT IMPLEMENTED**

---

## 1. Pipeline verification — MEASURED / PASS

```text
capture ? MediaPipe landmarks ? 5-pt ArcFace align ? 112×112 RGB NCHW
? (x-127.5)/128 ? w600k_mbf ? 512-D ? L2 ? cosine distance
```

| Stage | Status |
|-------|--------|
| Detector / alignment / preprocess / model versions bound on enroll | PASS |
| Enroll vs auth recognition path identical | PASS |
| Multi-frame enrollment path | PASS (`captureSilentFaceEnrollmentFromWebCamera` + `enrollFromImageFrames`) |
| Auth silent capture | Single accepted frame + blink liveness (by design) |

---

## 2. Model verification — MEASURED / PASS

| Property | Value | Evidence |
|----------|-------|----------|
| Input | `input.1` `[1,3,112,112]` float32 | MEASURED |
| Norm | `(x-127.5)/128` RGB NCHW | MEASURED (code) |
| Output | `516` `[1,512]` float32 | MEASURED |
| Raw L2 | not unit | MEASURED |
| App L2 | yes | MEASURED |
| Hidden projection | none | MEASURED |

---

## 3. Benchmark dataset — NOT MEASURED

No labeled face dataset is checked into the repo.

Harness:

```bash
node scripts/run-biometric-benchmark.mjs --dataset labeled.json --out report.json
```

Dataset schema supports `subject_id`, `imagePath`, `split`, `sessionId`, plus **required** 512-D embeddings from the **exact** production pipeline. Demographics only if ground-truth labels exist (never inferred).

`--plumbing-only` = metric math only ? **not** accuracy evidence.

---

## 4–7. 1:1 results / ROC / EER / FAR–FRR / threshold — NOT MEASURED

| Metric | Status |
|--------|--------|
| Genuine/impostor distributions | NOT MEASURED |
| FAR / FRR / TAR / TRR / ROC / EER | NOT MEASURED |
| TAR @ FAR 1e-2 … 1e-6 | NOT MEASURED |
| Production threshold selection | **THRESHOLD_STATUS = UNCALIBRATED** |

Legacy operating distance `0.35` remains in code as a placeholder. See `THRESHOLD_POLICY.md`.

Gate: `BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD=true` ? fail closed with `BIOMETRIC_THRESHOLD_UNCALIBRATED`.

---

## 8. 1:N results — NOT MEASURED (architecture hardened)

Logical identify path (implemented):

```text
probe ? ANN Top-K (10|50|100) ? exact cosine rerank ? threshold ? identity | NO_MATCH
```

| Item | Status |
|------|--------|
| Top-1-only accept | REMOVED |
| Rank-1/5/10 on labeled galleries | NOT MEASURED |
| Galleries 10K / 100K / 1M biometric | NOT MEASURED |

---

## 9. ANN / pgvector results

| Experiment | Status |
|------------|--------|
| Node brute-force synthetic 10K/100K | MEASURED previously (infra only) |
| Live pgvector HNSW 10K/100K/1M | **NOT_RUN** without `DATABASE_URL` |

```bash
DATABASE_URL=postgres://... node scripts/run-pgvector-hnsw-benchmark.mjs \
  --sizes 10000,100000,1000000 --top-k 10,50,100 \
  --m 16 --ef-construction 64 --ef-search 64
```

Configurable: `m`, `efConstruction`, `efSearch`, `K`. Synthetic vectors only.

---

## 10. PAD status — INCOMPLETE

| Layer | Coverage |
|-------|----------|
| FACE DETECTION | MediaPipe |
| FACE QUALITY | Heuristic gate |
| ACTIVE LIVENESS | Blink blendshapes |
| PRESENTATION ATTACK DETECTION | **INCOMPLETE** |
| MiniFASNet | **NOT PRESENT** / **NOT IMPLEMENTED** |

Blink does **not** claim protection against print, replay, screen, 3D-mask, or deepfake injection.

Formal interface: `toFormalPadResult` / `getPadDeploymentStatus()` ? `PAD_STATUS = INCOMPLETE`.

---

## 11. Enrollment aggregation — IMPLEMENTED (accuracy effect NOT MEASURED)

- Quality filter via pipeline rejection
- Duplicate-frame skip (`sim ? 0.995`)
- Quality-weighted mean ? L2 primary
- Gallery vectors stored in envelope
- Auth remains single-frame + blink

Effect on FAR/FRR vs single-frame: **NOT MEASURED** (needs labeled multi-shot set).

---

## 12. Security findings — PARTIAL

| Control | Status |
|---------|--------|
| Full-gallery `matchInMemory` fallback | **REMOVED** — fail closed `BIOMETRIC_SERVICE_UNAVAILABLE` |
| Bounded ANN Top-K + statement timeout | IMPLEMENTED |
| Vectors in structured match logs | Avoided (redacted) |
| Audit events store distance/metadata not raw vectors | PASS (current paths) |
| TLS in transit | INFERRED (platform HTTPS) — ops must enforce |
| Encryption at rest | INFERRED / platform-dependent — **NOT MEASURED** here |
| Legacy template rejection | PASS |
| Model version on envelope | PASS |
| Replay protection of biometric HTTP payloads | PARTIAL / platform session+WebAuthn — dedicated biometric nonce **NOT IMPLEMENTED** as dedicated control |
| Prefer master-device crypto over global 1:N | PRESERVED (Path A 1:1 when `cachedTrustId`) |

Regression tests: `apps/api/tests/vector-matcher-fail-closed.test.ts`.

---

## 13. Known limitations

1. No labeled biometric accuracy numbers  
2. Threshold uncalibrated  
3. PAD incomplete  
4. Live HNSW scale unbenchmarked in CI  
5. Without pgvector, 1:N fail-closed (hot cache ?256 still works)  
6. 10B architecture not designed / not claimed  

---

## 14. Explicit 10B readiness — BLOCKED

Required before designing/claiming 10B-scale identification:

1. Labeled FAR/FRR/EER/TAR through this pipeline  
2. Calibrated threshold policy (`CALIBRATED`)  
3. 1:N Rank/FPIR/FNIR on real galleries the data supports  
4. Live HNSW metrics at 1M+ with Top-K recall  
5. Validated PAD (or explicit risk acceptance)  
6. Shard/ops model based on measured QPS/latency — not Node brute-force  

**Do not claim 10 billion identities supported.**

---

## Completed (this hardening phase)

- Removed full-gallery Node fallback; fail-closed ANN unavailable  
- Explicit 1:1 verify vs 1:N identify APIs/semantics  
- Top-K ANN + exact cosine rerank + threshold NO_MATCH  
- Threshold policy doc + `UNCALIBRATED` status + optional hard gate  
- Multi-frame enrollment capture + quality-weighted aggregation  
- Formal PAD status = INCOMPLETE  
- pgvector Top-K SQL helper + live HNSW bench script  
- Regression tests for fail-closed / rerank / enrollment / PAD  

## Remaining blockers

1. Labeled dataset evaluation  
2. Threshold calibration  
3. Live pgvector scale numbers  
4. Complete PAD model  
5. Biometric payload replay nonce (dedicated) if required by threat model  

## Evidence required before production biometric launch

- Measured FAR/FRR/EER/TAR @ target FARs  
- Versioned `CALIBRATED` threshold policy  
- Fail-closed tests green in CI  
- PAD risk decision documented  
- Prefer master-device / 1:1 for routine auth  

## Evidence required before 10B design

- All of the above, plus measured ANN capacity curves and shard strategy inputs — **no redesign in this phase**
