# TrustID Biometric Assurance and 1:N Foundation V1

- Evidence date: 2026-09-29
- Repository: `C:\Users\Hp\Desktop\TRUST ID`
- Branch: `main`
- Pre-change HEAD: `666d6e101052bf1e62e132e1de11d1147fa43f9e`

This document separates implemented controls, structural tests, estimates, and missing real-human evidence. It does not claim biometric accuracy, calibrated thresholds, complete PAD, mobile runtime verification, or large-scale production capacity.

## Pre-change working tree

The following work existed before this mission and was preserved:

```text
 M apps/web/public/models/trustid/manifest.json
?? Dockerfile
?? apps/device/android/.idea/
?? apps/web/.netlify/
?? apps/web/public/mediapipe/
?? scripts/check-pgvector.mjs
```

The prior Authority Foundation baseline remains in `docs/AUTHORITY_FOUNDATION_BASELINE.md`. No setup/reset, database migration, commit, push, or deployment was performed.

## Security-critical SHA-256 baseline

These hashes were recorded before this mission changed repository files. They are the integrity comparison point for this work.

| File | Pre-change SHA-256 |
|---|---|
| `packages/sdk/src/capture/biometric/pipeline.ts` | `1D3DA522C711695538260768E33450FB78A1E9BC2670C72B5DDFDD1C3098F257` |
| `packages/sdk/src/capture/biometric/recognizer-arcface.ts` | `C57BAAE1652B814D8772B15E5B78B3A57952A195F0F0EC4D56D5D86C816E4AFE` |
| `packages/sdk/src/capture/biometric/enrollment.ts` | `1DCD4129AE5B14F546F29D3D6B135A345F9D5765DFE9734491E0FE91A349B054` |
| `packages/sdk/src/capture/biometric/pad.ts` | `9DF9F79E5AA7DE92EA0FDFFCBA2625D85B263DC184664DB8A2636EEF80162E33` |
| `apps/api/src/modules/trust-id/vector-matcher.ts` | `05A010E11BD508D99EE455452965A8B06D9427C0592ABF6748A68DCDBC86D2DF` |
| `apps/api/src/modules/trust-id/ann-rerank.ts` | `025B079E18A0114FBAC6F7E91FDAD22427F2C5AF6C9BB32E1B4FCEB163D61CF8` |
| `apps/api/src/modules/trust-id/match-semantics.ts` | `D6A99A4ABBFA2E4DFF007185EC793C975284C245E3D363C0F644978D14AEAD1E` |
| `apps/api/src/modules/trust-id/matcher.ts` | `7FC781090D14B9CD84EBFA6118CA1E1460B6BA2B2EA76A6F7770236911AA8FED` |
| `apps/api/src/modules/trust-id/fast-vector-match.ts` | `C8F275BFC23C23ABE5B4F913D7E4FADB662B634D4FDBE6D8B1BB48CE3FC4DEA3` |
| `apps/api/src/modules/authentication/service.ts` | `B95D08D5A32580144DDB7FCBEF364E1CA5125EB500BEABAEFAC388994F901D97` |
| `apps/api/src/modules/authentication/device-install.ts` | `82F9C6CC0762B0AD350DE8A2914AAFD01C1825E4FD2AF9A2EC524B40E82DADDB` |
| `apps/api/src/modules/authorization/service.ts` | `0B8E9B7CB2918886F48F2700AF41FF9E9B7144770EA64ED951ECC9F68F09B023` |
| `apps/api/src/routes/auth.ts` | `8C897FDE5E5C1B5BF58679DAA72AC18BE3F5575F9B41CCB5230510804AD6120A` |
| `apps/api/src/routes/biometric-eval.ts` | `8D757A77B77183C457F63D0BAF95862D04E2B03C6903B8B0E83640C3C66B7AAB` |
| `apps/api/prisma/schema.prisma` | `EC524E631DBCD431D42F1A7AED38F6F3AC397274AF3E5EF024D0B1ADABA97B24` |
| `apps/api/prisma/pgvector_setup.sql` | `916F03828139BB164FDB561AD84340950E6A58265B6C488AC5293680B138C9AF` |
| `packages/shared/src/index.ts` | `AEB39380E6DCD1B049C31C9DB0A7CAD9DBFD4A64C311A5D994D9C1CF85FB17E0` |

## Actual biometric pipeline

| Stage | Status | Implementation and boundary |
|---|---|---|
| Capture | IMPLEMENTED | Browser/WebView `getUserMedia` in `silent-camera-web.ts`; optional native bridge in `silent-camera-native.ts`. Raw frames are transient client memory. |
| Detection | IMPLEMENTED | MediaPipe Face Landmarker, self-hosted WASM/model assets, single-face requirement. |
| Alignment | IMPLEMENTED | Five-point ArcFace similarity transform to 112 x 112. |
| Quality | IMPLEMENTED | Face size, detector confidence, geometry, blur/exposure/pose checks. Values are capture quality, not identity confidence. |
| PAD/liveness | PARTIAL | Active blink challenge only. Print, replay, mask, and deepfake PAD are not implemented or evaluated. |
| Preprocessing | IMPLEMENTED | 112 x 112 RGB, NCHW float32, `(x - 127.5) / 128`. |
| Embedding | IMPLEMENTED | InsightFace ArcFace `w600k_mbf`, ONNX Runtime Web, native 512 dimensions. |
| Normalization | IMPLEMENTED | Client output and server input are L2 normalized. Non-finite and zero-norm server inputs fail closed. |
| Enrollment aggregation | IMPLEMENTED | Quality-filtered multi-frame gallery, near-duplicate-frame removal, quality-weighted mean primary template. Browser registration may reuse the successful lookup capture. |
| Storage | IMPLEMENTED / PARTIAL | JSON envelope is AES-GCM sealed. The pgvector 512-D ANN column is plaintext and searchable. Raw frames are not intentionally persisted by the authentication path. |
| ANN retrieval | IMPLEMENTED | PostgreSQL pgvector HNSW, cosine operator `<=>`, `m=16`, `ef_construction=64`, default `ef_search=64`, default K=50, allowed K 10/50/100. |
| Reranking | IMPLEMENTED | Bounded Top-K candidates are opened from sealed envelopes and exactly cosine-reranked. No full-gallery Node fallback in production. |
| Decision | IMPLEMENTED / UNCALIBRATED | Best candidate must pass cosine distance 0.35. Close distinct passing candidates fail closed as ambiguous. The 0.02 ambiguity margin is conservative safety policy, not calibration evidence. |
| Session | IMPLEMENTED | A match enters session/device policy. It does not itself grant arbitrary authority. |
| Unknown device | IMPLEMENTED / PARTIAL | Existing identities require master-device approval. Approval-service failure now fails closed without minting a session. |
| Audit | IMPLEMENTED | Match, failure, enrollment, duplicate block, and approval failure record metadata without vectors or raw images. |

## Current truth

- Embedding model: `insightface_arcface_w600k_mbf_v1`.
- Embedding dimensions: 512.
- Normalization: L2.
- Metric: cosine distance, `1 - dot(unit_probe, unit_template)`.
- Threshold: 0.35 cosine distance.
- Threshold source: legacy placeholder policy, not a labeled evaluation.
- `THRESHOLD_STATUS = UNCALIBRATED`.
- PAD: MediaPipe active blink liveness only.
- `PAD_STATUS = INCOMPLETE`.
- Quality gate: detector confidence plus face size/geometry/blur/exposure/pose checks.
- 1:1: claimed TrustID fetches only that active face template; no gallery scan.
- 1:N: bounded HNSW Top-K, exact rerank, threshold, ambiguity/no-match decision.
- Raw image retention: no intended retention in the authentication/enrollment path. The internal consented evaluation collector may retain controlled evidence separately.
- Health endpoint truthfully reports uncalibrated threshold, incomplete PAD, sealed JSON envelopes, and plaintext ANN columns.

## Identity operations

### 1:1 verification

A claimed TrustID plus a fresh probe compares only against the claimed identity's compatible active template. Result states include match, no match, legacy/incompatible model, uncalibrated-policy gate, malformed embedding, and service failure. Capture-stage states separately include no face, multiple faces, quality rejection, PAD rejection, and model unavailable.

### 1:N identification

An unknown probe produces a bounded candidate list. Candidate retrieval is not authentication. Candidates are reranked exactly and then evaluated for match, ambiguous, or no match. ANN/database unavailability fails closed and does not trigger a full-gallery application scan.

### Human and future Digi Twin assisted resolution

A future Digi Twin may supply context or candidate-assistance signals. It may not establish identity, change biometric scores, choose a threshold, mint a TrustID session, or grant authority.

**Digi Twin is not identity authority. TrustID remains identity authority. Digi Authority remains authorization authority.**

## Evaluation contract

`evaluation/contract.ts` defines a canonical trial with:

- real-human versus synthetic/fixture evidence class;
- 1:1, 1:N, or duplicate-enrollment operation;
- enrollment/probe sample and subject identifiers;
- browser, platform, device class, optional camera metadata;
- lighting, pose, distance, expression, glasses, session, and condition tags;
- model name/version, dimensions, preprocessing, normalization, and metric;
- distance/similarity, quality result, PAD result, expected relationship, actual decision, threshold, candidates, stage latency, timestamp, and run ID.

Structural validation does not verify consent or provenance. Only a valid `REAL_HUMAN` record is eligible for later accuracy analysis. Synthetic fixtures remain software/performance evidence.

The metrics tooling supports genuine/impostor distributions, FMR/FAR, FNMR/FRR, TAR, TRR, ROC, EER, threshold sweep, operating-point estimability, Wilson intervals, candidate recall@K, ambiguous rate, no-match rate, and candidate/re-ranking/total latency. It refuses to propose a calibrated threshold from synthetic or insufficient data.

## Duplicate enrollment

The implemented enrollment gate is separate from login:

```text
new enrollment probe
  -> compatible model/version validation
  -> bounded 1:N candidate retrieval
  -> exact rerank
  -> CLEAR | REVIEW_REQUIRED | AMBIGUOUS | SERVICE_UNAVAILABLE
  -> automatic creation only for CLEAR
```

ANN proximity never merges accounts. One passing existing candidate requires stronger verification/account recovery. Multiple close candidates require review. Search failure blocks automatic enrollment. The check occurs before a new user row is created.

Remaining concurrency limitation: candidate search and user creation are not one serializable cross-service transaction. Two simultaneous first-time enrollments for the same previously unseen human could both observe `CLEAR`. A production design needs a serialized enrollment claim, advisory/shard lock, or durable review queue keyed by a privacy-preserving enrollment transaction. A database uniqueness constraint cannot express cosine proximity.

## Model versioning

Face enrollment and matching require the active model name and numeric version. 1:N candidate queries filter active face rows to the current model/version. The sealed template envelope records:

- schema;
- primary and bounded gallery templates;
- model name/version;
- embedding dimensions;
- L2 normalization;
- cosine-distance metric;
- detector, alignment, preprocessing, and pipeline versions.

The Prisma row already stores model name/version. No production migration was performed. A future V2 rollout requires parallel indexes or model-version partitions, dual capture/re-enrollment, measured V1/V2 policy, and explicit retirement. V1 and V2 vectors must never be silently compared.

## Privacy and storage

- Raw camera frames are cleared after processing and are not sent by the normal web authentication path.
- API schemas and responses do not return embeddings.
- Match logging deletes vector/embedding fields and records distances/reason metadata only.
- Evaluation capture is a separate consented internal flow with deletion and export controls.
- Sealed JSON envelopes protect stored template payloads at rest when the sealing key is protected.
- The pgvector ANN column is plaintext to PostgreSQL. It is sensitive biometric-derived data and requires database access control, encrypted volumes/backups, transport encryption, retention/deletion controls, monitoring, and regional/data-residency policy.
- Debug/model diagnostics must remain metadata-only; captures and reusable vectors must not be written to logs.

## Scale model

A 512-D pgvector `vector` uses approximately `4 * 512 + 8 = 2,056` bytes before row/index overhead. The table below is arithmetic for raw vector payload only. HNSW graph, tuple, indexes, replicas, WAL, sealed envelopes, and operational headroom increase it materially.

| Identities | Raw vector payload | Status |
|---:|---:|---|
| 10K | about 20.6 MB | ESTIMATED; feasible benchmark target |
| 100K | about 205.6 MB | ESTIMATED |
| 1M | about 2.06 GB | ESTIMATED |
| 10M | about 20.6 GB | ESTIMATED; partition/operations planning required |
| 100M | about 205.6 GB | ESTIMATED; multi-partition service required |
| 1B | about 2.06 TB | UNPROVEN; multi-region/shard architecture required |
| 10B | about 20.6 TB | UNPROVEN; current single-index deployment is not suitable |

The current `m=16` HNSW graph adds neighbor links and implementation overhead. Actual index size must be measured from `pg_relation_size` for each PostgreSQL/pgvector version and data distribution. The repository harness can create a disposable benchmark table, measure insert/index build, table/index size, recall proxy, K=10/50/100 latency, and QPS. It must never be run against a valuable production database.

Progression beyond one deployment requires model-version and regional partitions, deterministic routing when identity context exists, federated candidate retrieval when it does not, bounded cross-shard reconciliation, replication, reindex strategy, hot/cold policy, and explicit failure domains. Global 10B face search is not established by this V1.

## Performance evidence

The repository contains `scripts/run-pgvector-hnsw-benchmark.mjs`. Its vectors are synthetic and valid only for infrastructure latency, storage, recall plumbing, and throughput. No reachable PostgreSQL+pgvector benchmark target was available in this environment, so live index size, latency, concurrency, and recall are unmeasured in this mission.

## PAD truth

Implemented defense: active blink challenge based on MediaPipe blendshapes, plus single-face and quality checks.

Not implemented/evaluated as PAD:

- printed photograph rejection;
- screen replay rejection;
- prerecorded video rejection;
- 3D mask rejection;
- deepfake or injected-camera rejection.

The repository has a fail-closed PAD implementation and a development-only bypass. Active blink is not complete presentation-attack detection. `PAD_STATUS` remains `INCOMPLETE`.

## Unknown-device flow

```text
unknown device
  -> fresh face capture
  -> 1:N candidate retrieval and exact verification
  -> identity assurance result
  -> risk/session policy
  -> master-device approval or appropriate step-up
  -> session only after policy succeeds
```

Existing: capture, 1:N, session service, master-device records, device approval requests, polling/claiming, audit.

Missing/partial: calibrated biometric threshold, complete PAD, durable cross-region approval availability, attested capture provenance, explicit risk engine, and runtime evidence on Android/iOS. Approval infrastructure failure now produces no session.

## Cross-platform boundary

| Biometric stage | Web | Android | iOS | Shared? |
|---|---|---|---|---|
| Capture | `getUserMedia`; implemented | Capacitor WebView/shared web capture; native bridge exists | Capacitor WebView/shared web capture; native bridge exists | Partial |
| MediaPipe | Browser WASM/model | Same web runtime in shell unless native bridge supplies capture | Same web runtime in shell unless native bridge supplies capture | Yes for TS/WebView |
| ArcFace | ONNX Runtime Web, WebGPU/WASM | Same web runtime in shell | Same web runtime in shell | Yes for TS/WebView |
| PAD | Active blink only | Same limitation | Same limitation | Yes for TS/WebView |
| Embedding | 512-D L2 ArcFace | Shared SDK path | Shared SDK path | Yes |
| 1:1 | Server API | Server API | Server API | Yes |
| 1:N | Server pgvector/HNSW | Server pgvector/HNSW | Server pgvector/HNSW | Yes |
| Session | Web cookie/device policy | Capacitor/device policy plus native biometric gate | Capacitor/device policy plus native biometric gate | Partial |

Web source/build tests do not prove mobile camera, GPU/WASM, permissions, lifecycle, or Secure Enclave/Keystore behavior. Genuine Android and iOS runtime verification is BLOCKED in this mission.

## Authority boundary

Biometric recognition contributes identity assurance. It does not grant owner, admin, financial, Digi Twin, or tool authority. A successful match must pass session, device, step-up, OAuth, and Digi Authority policy. Unknown-device approval failure now fails closed. Prompt text, client-claimed scores, client thresholds, and client PAD booleans are not authorization.

## Production configuration observation

Repository configuration shows Netlify proxying `/api` to an existing Railway API and Railway boot configured through the root start command. The Railway CLI was not installed in this environment, so live Railway variables, linked project state, PostgreSQL extension/index state, and production biometric data were not inspected. No production configuration was changed.

## Evidence limitations

- No compliant real-human labeled dataset is present.
- No genuine/impostor accuracy result can be reported.
- Threshold 0.35 remains uncalibrated.
- No PAD attack corpus or measured APCER/BPCER exists.
- No live PostgreSQL+pgvector benchmark ran.
- Android and iOS runtime ceremonies did not run.
- Client-produced face embeddings/PAD metadata are not hardware-attested; a compromised client can submit arbitrary vectors. Server-side threshold/model/dimension policy prevents simple field manipulation but does not provide capture provenance.
- Simultaneous duplicate enrollment still needs a durable serialization design.

## Required next evidence

1. Consent-approved, subject-disjoint real-human development/validation/test captures across supported browsers, devices, sessions, lighting, pose, distance, expression, glasses, and cameras.
2. Exact production-pipeline embeddings and immutable run/model metadata.
3. FMR/FNMR/ROC/EER and operating-point confidence intervals with sufficient impostor trials.
4. Separate PAD evaluation for photo, screen replay, video, mask, and injection classes.
5. Disposable PostgreSQL+pgvector benchmarks at feasible 10K/100K/1M scales, including concurrent queries and exact-recall comparison.
6. Physical Android and iOS runtime verification.
7. Production-safe duplicate-enrollment serialization and human/account-recovery review policy.
