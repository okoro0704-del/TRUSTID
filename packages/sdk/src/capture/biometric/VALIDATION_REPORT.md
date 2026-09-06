# ArcFace Pipeline Scientific Validation Report

**Commit audited:** `7a4fb8c` (+ follow-up envelope parse fix in `fast-vector-match.ts`)  
**Generated:** 2026-09-06  
**Scope:** Measurement and audit only. No 10B redesign. No production threshold change.

---

## A. PIPELINE VALIDATION

| Stage | Status | Notes |
|-------|--------|-------|
| Camera capture | PASS | `captureSilentFaceFromWebCamera` ? ImageData frames |
| MediaPipe Face Landmarker | PASS | Same detector for enroll/auth path |
| Face detection | PASS | `detectFacesInImageData` / `selectPrimaryFace` |
| Landmarks ? 5-point | PASS | Mapped to ArcFace 5-point set |
| ArcFace alignment | PASS | Umeyama ? InsightFace 112×112 template |
| 112×112 normalization | PASS | RGB NCHW `(x-127.5)/128` |
| ArcFace `w600k_mbf` | PASS | ONNX via `onnxruntime-web` |
| 512-D embedding | PASS | Native 512; rejects other sizes |
| L2 normalization | PASS | Client `l2Normalize` after ONNX |
| Template storage | PASS* | Envelope `trustid_face_template_v1` + pgvector primary |
| 1:1 verification | PASS* | Path A now parses envelope `primary` (was broken) |
| 1:N search | PASS/WARN | pgvector HNSW; falls back to full-table Node scan |

### Enroll vs auth consistency

| Component | Same? | Evidence |
|-----------|-------|----------|
| Detector | YES | `mediapipe_face_landmarker_v1` |
| Alignment | YES | `arcface_five_point_v1` |
| Crop / preprocess | YES | `arcface_112_rgb_v1` |
| Model | YES | `insightface_arcface_w600k_mbf_v1` v1 |
| Embedding L2 norm | YES | Both via `embedAlignedFace112` |
| Similarity metric | YES | Cosine distance `1 - dot` / pgvector `<=>` |
| PAD timing | DIFFERENT | Auth silent path: `skipPad: true` then blink PAD on stream; pipeline PAD skipped for embed frames |
| Multi-frame enroll | DIFFERENT | `enrollFromImageFrames` (mean template) exists but **silent capture stores a single frame** — not mean of gallery |

### Inconsistencies (non-blocking for recognition identity of single frame)

1. **Silent capture does not use `enrollFromImageFrames`** — enrollment quality strategy unused in production capture.
2. **PAD is applied outside the shared embed call** (`skipPad: true`) — recognition tensor path still identical; liveness is sequential blink challenge.
3. **`projectTo512` still exported** but marked deprecated; production face path does not use it for ArcFace.
4. **1:1 Path A previously parsed `embeddingJson` as raw `number[]`** — broken for envelope templates; **fixed in this validation pass**.

---

## B. MODEL VALIDATION

Measured against `apps/web/public/models/trustid/w600k_mbf.onnx`:

| Property | Measured value |
|----------|----------------|
| SHA-256 | `9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f` |
| File size | 13,616,099 bytes |
| ONNX input name | `input.1` |
| Input dims | `[1, 3, 112, 112]` float32 NCHW |
| Channel order | RGB (aligned in `alignFaceToArcFace112`) |
| Input normalization | `(x - 127.5) / 128` |
| ONNX output name | `516` |
| Output dims | `[1, 512]` float32 |
| Output datatype | float32 |
| Raw output L2 norm | **not** unit (zero-input ? 5.98; random ? 11.05) |
| App output normalization | L2 unit vector after inference |
| Hidden projection | **NONE** — rejects non-512 lengths |
| Determinism (same input) | cosine ? 1.0 |
| Cosine similarity | `dot(u,v)` on L2-normalized vectors |

Runtime: `onnxruntime-web` WebGPU ? WASM fallback. CDN WASM paths pinned to 1.21.0.

---

## C. BIOMETRIC RESULTS

**Labeled face dataset in repo: ABSENT.**

| Metric | Result |
|--------|--------|
| Genuine / impostor distributions | **MISSING** |
| FAR / FRR / ROC / EER | **MISSING** |
| TAR @ FAR 1e-2 … 1e-6 | **MISSING** |
| Rank-1 / 5 / 10 | **MISSING** |
| FPIR / FNIR | **MISSING** |
| Galleries 10K / 100K / 1M / 10M (biometric) | **SKIPPED_INSUFFICIENT_GALLERY** |

Harness ready:

```bash
node scripts/run-biometric-benchmark.mjs --dataset path/to/labeled.json --out report.json
```

`--plumbing-only` exercises metric code on synthetic vectors and is **not** accuracy evidence.

---

## D. THRESHOLD RECOMMENDATION

| Field | Value |
|-------|-------|
| Current production threshold | cosine distance **0.35** (similarity 0.65) |
| Proposed threshold | **none** |
| FAR/FRR @ current | **unmeasured** |
| Status | **`THRESHOLD_CANNOT_BE_CALIBRATED_WITH_CURRENT_DATA`** |

Do not change `BIOMETRIC_PGVECTOR_MAX_DISTANCE` until a labeled production-pipeline embedding set is evaluated.

---

## E. SEARCH RESULTS

### Biometric accuracy vs ANN

| Category | Status |
|----------|--------|
| BIOMETRIC ACCURACY | NOT MEASURED (no labeled faces) |
| ANN SEARCH PERFORMANCE | Partial baseline only |

### Node brute-force baseline (synthetic unit vectors — NOT recognition accuracy)

| Gallery | p50 latency | QPS | recall@1 (planted exact) |
|---------|-------------|-----|---------------------------|
| 10K | ~14.6 ms | ~68 | 1.0 |
| 100K | ~139 ms | ~6.7 | 1.0 |
| 1M+ | not run here (memory / time) | — | — |

### pgvector / HNSW (production config)

| Item | Status |
|------|--------|
| Live HNSW bench | **NOT_RUN** (no `DATABASE_URL` in validation environment) |
| Index params | `m=16`, `ef_construction=64`, `ef_search=40` |
| Query | `LIMIT 1`, cosine `<=>`, threshold 0.35 |
| 10M / 100M / 1B | **NOT MEASURED** |

---

## F. PAD ASSESSMENT

| Layer | Current coverage |
|-------|------------------|
| FACE DETECTION | MediaPipe Face Landmarker |
| FACE QUALITY | Size / blur / pose heuristics (`face-quality.ts`) |
| LIVENESS | Active blink via blendshapes (`mediapipe_blink_active_v1`) |
| PRESENTATION ATTACK DETECTION | **Incomplete** — blink ? print/replay/deepfake PAD |
| FACE RECOGNITION | ArcFace `w600k_mbf` |

**Do not describe blink as complete anti-spoofing.**

MiniFASNet (or equivalent validated PAD) integration point: `FacePresentationAttackDetector` in `pad.ts` / `types.ts`; production factory currently returns `MediaPipeBlinkPadDetector`. Artifact path reserved under `/models/trustid/pad/`. Fail-closed path exists (`FailClosedPadDetector`). No stub PAD deployed as “real” PAD.

---

## G. TOP BLOCKERS (global production-grade 1:N)

1. **No measured FAR/FRR/EER/TAR on labeled faces through this exact pipeline**
2. **Uncalibrated threshold 0.35** (legacy-era constant; not ArcFace-calibrated here)
3. **Full-table `matchInMemory` fallback** — loads entire active gallery into Node on pgvector failure (**scalability + security blocker**)
4. **HNSW Top-1 only** — no Top-K rerank; ANN recall ? biometric accuracy
5. **PAD incomplete** — blink only; no validated print/replay PAD
6. **Single-frame enrollment in silent capture** — multi-template helpers unused
7. **pgvector HNSW unbenchmarked at 1M–1B** in this pass
8. **No demographic-labeled evaluation set**

---

## H. 10B READINESS (measurements still required — no redesign yet)

Before designing a 10B system, obtain:

1. Labeled genuine/impostor set through **this exact** detector?align?`w600k_mbf` path (report FAR/FRR/EER/TAR @ 1e-2…1e-6)
2. Closed-set Rank-N + open-set FPIR/FNIR on real identity counts the data supports (no identity duplication to fake 10M)
3. Threshold calibration from those distributions only
4. Template strategy A/B (single vs mean vs multi) on real multi-shot enrollments
5. Live pgvector HNSW: build time, size, RAM, p50/p95/p99, QPS, recall@1/@10 vs exact at 1M ? 10M ? 100M (1B if practical)
6. Removal/replacement plan for full-table Node fallback (fail closed or shard-local exact, not full dump)
7. Validated PAD model evaluation (separate from recognition metrics)
8. Operational facts: shard key, replica topology, enrollment write path, purge/re-enroll for model version bumps

**Do not claim “10 billion identities supported.”**

---

## Full-table fallback (blocker detail)

| Location | Behavior |
|----------|----------|
| `apps/api/src/modules/trust-id/vector-matcher.ts` ? L273 | `matchPgVector(...) ?? matchInMemory(...)` |
| `matchInMemory` ? L443–484 | `biometricEmbedding.findMany` all active rows ? cosine in Node |

**Replacement (report only):** fail closed on pgvector errors for 1:N; or shard-scoped exact search; never load the global gallery into application memory.

---

## How to produce real biometric numbers

1. Capture labeled images (multiple per identity) with known IDs.
2. Embed each image with the **production** web/SDK pipeline (same model versions).
3. Export JSON per `packages/sdk/src/capture/biometric/benchmark/dataset.ts` schema.
4. Run `node scripts/run-biometric-benchmark.mjs --dataset <file> --out report.json`.
5. Optionally tag `failureModes` / `demographics` **only if ground-truth labels exist**.
