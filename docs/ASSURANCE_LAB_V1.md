# TrustID Biometric Calibration & Assurance Lab V1

Evidence date: 2026-09-29
Repository: `C:\Users\Hp\Desktop\TRUST ID`, branch `main`, pre-change HEAD `666d6e101052bf1e62e132e1de11d1147fa43f9e`

The Assurance Lab is a development/test harness that turns consenting participants' biometric sessions into labelled evaluation evidence for the **existing** pipeline (MediaPipe detection, 5-point ArcFace alignment, `w600k_mbf`, 512-D, L2, cosine distance, pgvector HNSW Top-K, exact rerank, ambiguity margin, duplicate gating). It is not a new algorithm and not a second evaluation system: it reuses `BiometricEvaluationTrial` validation, `ratesAtThreshold`, `computeVerificationReportFromScores`, `farEstimability`, `wilsonInterval95`, `computeIdentificationDecisionMetrics` and `assignSubjectDisjointSplits` from `packages/sdk/src/capture/biometric/{benchmark,evaluation}`.

A lab match is an **evaluation result**. It never creates a session, TrustID, authorization, Digi Authority grant, or production biometric row.

No real-human data has been collected. **CALIBRATION ù READY FOR DATA COLLECTION.** The production threshold (0.35, `UNCALIBRATED`) is unchanged.

## Components

| Layer | Location | Role |
|---|---|---|
| Lab core (pure) | `packages/sdk/src/capture/biometric/assurance-lab/` (export `@trustid/sdk/assurance-lab`) | protocol, consent, evidence validation, pairs, sweep, recommendation, 1:N, open set, duplicate evaluation, PAD, isolation, export |
| Lab store | `apps/api/src/modules/assurance-lab/store.ts` | file-based, pseudonymous, outside the production DB |
| Lab service | `apps/api/src/modules/assurance-lab/service.ts` | injects the production decision functions (`exactRerankCandidates`, `decideAfterRerank`, `assessDuplicateEnrollmentCandidates`) read-only |
| Lab routes | `apps/api/src/routes/assurance-lab.ts` (`/internal/assurance-lab/*`) | gated, secret-protected, no cookies |
| Dashboard | `apps/web/src/pages/internal/AssuranceLab.tsx` (`/internal/assurance-lab`) | dev build only (`import.meta.env.DEV`) |
| Race fix | `apps/api/src/modules/trust-id/enrollment-serialization.ts` + `fusion.ts` | durable Postgres advisory lock |
| Benchmark | `scripts/assurance-lab-pgvector-benchmark.mjs` | local disposable DB only |

## Running the lab

| Variable | Default | Meaning |
|---|---|---|
| `TRUSTID_ASSURANCE_LAB_ENABLED` | unset | must be `true`; otherwise every lab route is 404 |
| `TRUSTID_ASSURANCE_LAB_SECRET` | unset | >= 16 chars, sent as `x-assurance-lab-secret` (constant-time compare) |
| `NODE_ENV` | - | lab routes are 404 when `production` |
| `TRUSTID_ASSURANCE_LAB_ROOT` | `<cwd>/artifacts/assurance-lab` | evidence store (git-ignored) |
| `TRUSTID_ASSURANCE_LAB_STUDY_ID` | `trustid_dev_study_v1` | study id |
| `TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP` | `3` | N per protocol step (not hardcoded) |
| `TRUSTID_ASSURANCE_LAB_RETENTION_DAYS` | `30` | evidence purged after this |

Start the API with those variables, run `npm run dev -w @trustid/web`, open `/internal/assurance-lab`, and unlock it with the secret. The secret stays in `sessionStorage` for the tab only.

## Isolation

- Routes import nothing from sessions, authorization, authentication, Digi Authority, the Prisma client, fusion, register, or the matcher. A static-import test enforces this.
- Lab responses pass `assertLabResponseIsolation` in a `preSerialization` hook. Any `trustId`, `userId`, `ownerId`, `sessionToken`, `token`, `accessToken`, `refreshToken`, `idToken`, `grantId`, `capability`, `authorityToken`, `setCookie` or `privateKey` key, at any depth, makes the response fail with 500.
- The `onSend` hook removes `set-cookie` and adds `cache-control: no-store` and `x-trustid-result-kind: EVALUATION_RESULT`.
- The dashboard uses `credentials: "omit"`, so production session cookies are never sent.
- The production configuration is exposed read-only with `writableFromLab: false`. No endpoint writes a threshold or environment variable. The dashboard has no production-changing control.
- The API test asserts that Prisma `user`, `biometricEmbedding` and `session` counts are unchanged after a full lab study, and that the threshold is still 0.35.
- Production users are never enrolled as participants automatically. Participants are created only through the consent ceremony.

## Consent

- The participant must type exactly `I CONSENT`. Anything else, including case variants or extra whitespace, is rejected.
- The record stores: pseudonymous participant ID (`lab_p_<24 hex>`), consent version, study version, timestamp, and the SHA-256 of the consent document shown.
- The consent document (`GET /consent`) states the purpose, what is collected, what is not (no raw images), retention, withdrawal, and that participation has no effect on any TrustID account.
- Withdrawal (`POST /participants/:id/withdraw`) deletes sessions, captures, PAD attempts and generated reports, then leaves only a `WITHDRAWN` tombstone. Reports are regenerated without the participant.

## Data handling

- Frames are processed in the browser. The embedding is computed client-side, the canvas is cleared, and only the 512-D vector plus metadata is posted.
- The API rejects any body field that looks like raw media (`image|frame|photo|picture|video|base64|blob|jpeg|png|webp|media`) or any `data:` URL, with 400 `RAW_MEDIA_NOT_ACCEPTED`, before validation.
- The store refuses records unless `rawImageRetained === false` (captures) or `rawMediaRetained === false` (PAD).
- The study config accepts only `rawImagePolicy: "TRANSIENT_NOT_RETAINED"`. Retaining images would need a separate consent class, which is not supported.
- Files are written atomically with mode `0600` under a path-escape guard. `artifacts/assurance-lab/` is git-ignored.
- Expired evidence is purged whenever a report is built.
- The legacy `biometric-eval` collector (`routes/biometric-eval.ts`) was not reused as-is. It retains images and has a fixed protocol. It is left unchanged.

## Study protocol

The default protocol has three sessions. N captures per step come from configuration, not code.

| Session | Minimum gap | Steps (allowed operator-labelled conditions) |
|---|---|---|
| A | - | A_BASELINE (NORMAL), A_POSE (POSE_VARIATION), A_DISTANCE (DISTANCE_VARIATION) |
| B | 1 h, different device/runtime preferred | B_BASELINE (REPEAT_BASELINE), B_LIGHTING (LOW_LIGHT / BRIGHT_LIGHT / SIDE_LIGHT) |
| C | 24 h | C_BASELINE (REPEAT_BASELINE), C_VARIATION (EXPRESSION_VARIATION / GLASSES) |

Each session records the platform (WEB / ANDROID / IOS), runtime, device class, and model name/version, which must equal the production model. A condition outside a step's allowed list is rejected.

**Sample-size rationale (calibration gates).** The target FMR is 1e-4. With zero observed false matches, bounding FMR at 1e-4 with 95% confidence needs at least ceil(3 / 1e-4) = 30,000 development impostor comparisons (rule of three). `farEstimability` must also report `ESTIMABLE`.

Further gates:
- at least 50 participants, each with at least 2 sessions;
- at least 1,000 genuine pairs;
- at least 2 platforms.

Participants are split subject-disjointly into development and validation sets. The recommendation rule picks the largest cosine-distance threshold whose FMR 95% Wilson upper bound is at or below the target on the development set, then checks it on validation. FNMR is reported, not optimised.

When any gate is unmet, the output is `THRESHOLD RECOMMENDATION ù INSUFFICIENT EVIDENCE`, and the unmet gates are listed. Synthetic evidence is always `SYNTHETIC_NOT_ELIGIBLE`. A candidate is always `appliesToProduction: false` and needs governance review.

## Evidence classes and pairs

- `REAL_HUMAN_CONSENTED` is set server-side on every API capture. It is operator-attested, not hardware-attested; see capture provenance below.
- `SYNTHETIC` exists only in tests and the benchmark.
- Mixing the two classes in one analysis is rejected.
- Genuine pairs are every same-participant pair across all accepted captures. No selection is made.
- Impostor pairs are exhaustive up to 5,000,000 pairs. Beyond that, a seeded uniform sample without replacement (seed 20260929) is drawn from all cross-participant pairs, with no score-based selection. The policy is recorded in the report.
- Quality-rejected captures count as failure-to-acquire (FTA) and are reported, not silently dropped.

## Metrics

- **Threshold sweep:** FMR, FNMR, TAR and TRR, using exact production semantics (`distance <= threshold` accepts).
- **ROC and EER:** from the reused metrics. EER on tiny samples is flagged as not meaningful.
- **1:N closed set:** Recall@1/5/10/50 and the outcome categories (correct match, wrong match, no match, ambiguous, service unavailable), produced through the production decision functions. The gallery is keyed by opaque gallery keys; participant IDs never reach the decider, and a test asserts this.
- **Open set:** each participant is held out of the gallery. An unknown human must yield `NO_MATCH`.
- **Duplicate evaluation:** CLEAR / REVIEW_REQUIRED / AMBIGUOUS / SERVICE_UNAVAILABLE through the production assessor. It never auto-merges. A simulated retrieval outage must produce SERVICE_UNAVAILABLE (fail closed).
- **PAD:** APCER per attack class and BPCER. Status is `EVALUATED` only with at least 100 bona fide attempts and at least 100 attempts per attack class. The lab records the outcome of the existing production PAD; it contains no attack tooling.
- **Export:** deterministic and aggregate-only. `generatedAt` and latency fields are excluded. `assertExportPrivacy` rejects vectors, raw media, credentials, tokens, keys, and TrustID/user identities.

## Duplicate-enrollment race fix

**Problem.** `autoEnrollFromBiometrics` ran the duplicate check, then created the user and template, with no serialization. Two concurrent enrollments of the same face could both see CLEAR and both create identities. The local Postgres control test reproduced this: more than one row was created without the lock.

**Fix.** `withBiometricEnrollmentLock` wraps the check-then-create critical section (`createIdentityWithTemplates`) in `fusion.ts`:

- **Postgres (production).** Inside an interactive transaction the code calls `pg_try_advisory_xact_lock(0x54494445, fnv(face:model:version))`, retrying with jittered backoff (10 ms to 250 ms).
  - The lock is transaction-scoped, so a crash or rollback releases it; it is durable across API replicas.
  - If it is not acquired within `TRUSTID_ENROLLMENT_LOCK_WAIT_MS` (15 s), the request fails closed with 503 `BIOMETRIC_SERVICE_UNAVAILABLE` (`enrollment_lock_timeout`).
  - The hold is bounded by `TRUSTID_ENROLLMENT_LOCK_HOLD_MS` (60 s).
  - It is not an in-memory mutex.
- **SQLite (dev/tests).** A single-process queue, labelled `SINGLE_PROCESS_DEV_ONLY`.
- **Schema.** No migration was required, and nothing was applied to any production database.

**Tests.**
- `duplicate-enrollment-concurrency.test.ts`: 2 simultaneous same-face enrollments give 1 user and one 409; a burst of 6 gives 1; a failing critical section does not wedge the queue.
- `enrollment-lock-postgres.test.ts`: runs on local Postgres only. Without the lock the race reproduces. With it, 12 concurrent enrollments give 1 CREATED and 11 DUPLICATE_BLOCKED. The lock is released after a throw, and the deadline returns 503.

**Remaining findings (not changed in this task).**
1. `POST /v1/trust-id/enroll-biometric` (`routes/trust-id.ts`) adds a template without any duplicate check. It is an authenticated add-template path, but it can attach a face already enrolled elsewhere.
2. The duplicate check relies on HNSW Top-K plus the hot cache (`vector-matcher.ts` `assessDuplicateEnrollment`). An ANN miss produces a false CLEAR. The synthetic benchmark below shows that ANN misses occur at 100K with production parameters.

## Capture provenance

Classifications: AVAILABLE / PARTIAL / NOT AVAILABLE / REQUIRES NATIVE BRIDGE / REQUIRES PLATFORM ATTESTATION. Browser JavaScript cannot provide hardware attestation of camera frames, and nothing here claims otherwise.

### Web (browser / PWA)

| Property | Status | Notes |
|---|---|---|
| Live camera capture (`getUserMedia`) | AVAILABLE | frames processed in-page, then discarded |
| Proof frames came from a physical camera (vs virtual camera / injected stream) | NOT AVAILABLE | virtual cameras and injected `MediaStream`s are indistinguishable to JS |
| Hardware attestation of frames or embedding | NOT AVAILABLE | no browser API exists |
| Device / camera label | PARTIAL | `enumerateDevices` labels and UA are spoofable |
| Runtime identification (browser, OS) | PARTIAL | UA / UA-CH, spoofable |
| WebAuthn authenticator attestation (existing, FIDO MDS in `modules/attestation`) | PARTIAL | attests an authenticator key, not the camera or frames |
| Model name/version metadata | PARTIAL | client-reported and validated against production, not attested |
| Operator-labelled conditions | AVAILABLE | operator attestation only |

### Android (Capacitor app, `apps/device`)

| Property | Status | Notes |
|---|---|---|
| Native CameraX capture (`SilentFaceCapturePlugin`) | AVAILABLE | returns a JPEG (base64) to the WebView for JS vectorization |
| End-to-end frame integrity native to embedding | PARTIAL | frames cross the JS bridge unsigned |
| Hardware-backed key (`AndroidKeyStore`, `SilentAuthPlugin`) | AVAILABLE | key exists; not bound to captures |
| Key attestation certificate chain (`setAttestationChallenge`) | REQUIRES NATIVE BRIDGE | not requested today |
| Signing capture/embedding with an attested key | REQUIRES NATIVE BRIDGE | not implemented |
| Play Integrity verdict (app/device integrity) | REQUIRES PLATFORM ATTESTATION | not integrated; needs a Google Cloud project and server verification |
| Emulator detection | PARTIAL | `Build.MODEL` is reported, not attested |

### iOS (Capacitor app, `apps/device/ios`)

| Property | Status | Notes |
|---|---|---|
| Face capture | PARTIAL | WKWebView `getUserMedia` only; no native face-capture plugin |
| Native AVCapture pipeline | REQUIRES NATIVE BRIDGE | not implemented |
| Secure Enclave key (`SilentAuthPlugin`, not on simulator) | AVAILABLE | key exists; not bound to captures |
| App Attest (`DCAppAttestService`) / DeviceCheck | REQUIRES PLATFORM ATTESTATION | not integrated |
| Build/runtime verification | NOT AVAILABLE | needs macOS + Xcode + device |

## Physical platform evidence

- **Android:** `adb devices -l` on 2026-09-29 lists only `emulator-5554` (`sdk_gphone64_x86_64`). No physical handset is attached, so **ANDROID PHYSICAL CEREMONY ù VERIFICATION BLOCKED**. Emulator runs are not physical-device evidence.
- **iOS:** the host is Windows; there is no macOS, Xcode, or iOS device. **IOS PHYSICAL CEREMONY ù VERIFICATION BLOCKED / REQUIRES MACOS/XCODE/IOS DEVICE**.

## pgvector benchmark ù SYNTHETIC INFRASTRUCTURE BENCHMARK

**This is not biometric accuracy.**

**Vectors.** Uniform random 512-D unit vectors, generated server-side. No faces and no production data.

**Host.** Local disposable container `supabase/postgres:17.6.1.155` (Postgres 17.6, pgvector 0.8.2, `shared_buffers` 128MB) on Windows / Docker Desktop.

**Database.** `assurance_bench_lab`, created from `template0` with no application tables.

**Script guards.** The script refuses:
- non-local hosts;
- database names without lab/bench/disposable;
- any database containing user, embedding, session, device, or trustid tables.

It uses a private schema and drops it afterwards.

**Index parameters.** Production HNSW parameters: `m=16`, `ef_construction=64`, `vector_cosine_ops`, `ef_search = max(64, topK)`, topK 50.

**Mated probes.** A stored vector plus Gaussian noise (norm 0.45), giving a mean cosine distance of about 0.088 to the source, well inside the 0.35 threshold.

| Metric | 10K | 100K |
|---|---|---|
| Insert | 1.2 s | 11.6 s |
| HNSW build (maintenance_work_mem 1GB, 2 workers) | 9.8 s | 215.9 s |
| Total relation size (heap + TOAST + indexes) | 56.0 MB | 559.1 MB |
| Bytes per vector (total) | 5,600 | 5,591 |
| Recall@10 vs exact (random probes) | 0.474 | 0.104 |
| Recall@50 vs exact (random probes) | 0.413 | 0.072 |
| Mated-probe recall @1 / @10 / @50 | 1.00 / 1.00 / 1.00 | 0.79 / 0.79 / 0.79 |
| ANN Top-50 latency p50 / p95 / p99 | 12.9 / 24.9 / 31.5 ms | 37.0 / 75.7 / 190.1 ms |
| Exact scan Top-K latency p50 / p95 | 38.0 / 65.7 ms | 1,140.9 / 2,262.7 ms |
| QPS at 1 / 4 / 16 clients | 63.5 / 88.7 / 145.2 | 25.8 / 57.5 / 73.6 |

**Lab-only `ef_search` sensitivity (100K).** This was a second, independent run: new random data, same production build parameters, `--ef-search-sweep`. Production still uses `max(64, topK)`, and nothing was changed.

| ef_search | Mated recall @50 | Recall@50 vs exact | Top-50 latency p50 / p95 |
|---|---|---|---|
| 64 (production) | 0.745 | 0.063 | 79.2 / 249.0 ms |
| 128 | 0.940 | 0.119 | 40.2 / 60.8 ms |
| 256 | 0.990 | 0.198 | 117.5 / 239.7 ms |
| 512 | 0.995 | 0.323 | 164.9 / 373.3 ms |

Latencies in this run are single-run and noisy on a shared Windows/Docker host; the 64 and 128 rows are out of order. Treat them as indicative only. The recall trend is the finding: at 100K, production `ef_search=64` leaves roughly 21-25% of mated synthetic probes unretrieved (0.79 and 0.745 across two runs), and `ef_search` of 256 or more recovers at least 99%. Any production change to `ef_search` is out of scope for this task. It needs real-embedding evidence, latency budgeting, and governance review.

**Interpretation.**

- **Random probes.** Recall vs exact on random probes is low because uniform random 512-D data has no neighbourhood structure: all points are nearly equidistant, which is the worst case for HNSW. Real face embeddings are clustered, so this figure is a pessimistic bound, not a prediction.
- **Mated probes.** The mated-probe result matters more. At 100K, 21% of near-duplicate probes did not find their source anywhere in the Top-50, and the rate is identical at K=1/10/50. These are graph-navigation misses, not ranking errors.
  - In production this would appear as a 1:N `NO_MATCH` for an enrolled person, or a **false CLEAR in the duplicate-enrollment check**.
  - Whether it occurs with real embeddings is **unproven** and must be measured with the lab's real-human gallery.
- **Exact rerank.** Exact rerank cannot recover candidates that ANN never returned.
- **Exact scan as a fallback.** Exact scan is already more than 1 s at 100K on this host, so it is not a scalable fallback.

Output: `artifacts/assurance-lab/benchmarks/pgvector-*.json` (git-ignored).

## Scale model (10K to 10B)

Storage uses the measured ~5.6 KB per vector (table + TOAST + HNSW + PK). Raw vector payload alone is 2,056 bytes (512 x float4 + 8-byte header).

| Gallery | Storage (measured rate) | Raw vectors only | Classification | Basis |
|---|---|---|---|---|
| 10K | 56 MB | 20.6 MB | BENCHMARKED | measured (synthetic) |
| 100K | 559 MB | 206 MB | BENCHMARKED | measured (synthetic); mated recall 0.745-0.79 at production ef_search=64, >= 0.99 at ef_search >= 256 |
| 1M | ~5.6 GB | 2.06 GB | EXTRAPOLATED | linear storage; build > 1 h expected (100K was 22x the 10K build); index (~2.75 GB) exceeds 1GB maintenance_work_mem; recall not measured |
| 10M | ~56 GB | 20.6 GB | UNPROVEN | single-node HNSW in RAM not demonstrated; recall trend unknown |
| 100M | ~560 GB | 206 GB | UNPROVEN | requires sharding/partitioned indexes; no such architecture exists in TrustID |
| 1B | ~5.6 TB | 2.06 TB | UNPROVEN | requires distributed ANN, compression/quantisation; none implemented |
| 10B | ~56 TB | 20.6 TB | UNPROVEN | no design, no benchmark; also far beyond meaningful 1:N FMR at threshold 0.35 |

**The false-match problem at scale.** Beyond storage there is an accuracy ceiling: at gallery size G, the chance of at least one impostor within threshold is about 1 - (1 - FMR)^G.

Example: at FMR 1e-6 and G = 10^8, this is essentially 1.

1:N at 10^8 and above therefore needs a far lower per-comparison FMR than anything measured so far. No FMR has been measured on real humans yet. HNSW working at 1M, which has not been shown either, would not establish 10B support.

## Limitations

- No real-human evidence has been collected, so no accuracy claim is made.
- Provenance is operator-attested only; web capture cannot be hardware-attested.
- PAD is the existing single-frame production PAD. No attack-class data has been collected, so the status is INCOMPLETE.
- Android physical and iOS verification are blocked by hardware.
- The benchmark is synthetic, one host, one run, sizes 10K and 100K only.
- **Deployment gap: the untracked `Dockerfile`.** It builds only `shared` and `api`.
  - The API already type-imports `@trustid/bbs-sdk`, which that Dockerfile does not build (pre-existing).
  - The lab adds type-only imports of `@trustid/sdk/assurance-lab`, so `tsc` for the API needs `packages/sdk/dist` as well.
  - At runtime the SDK is loaded lazily, and only when a lab route is enabled. The image sets `NODE_ENV=production`, so the lab routes are 404 there and never load it.
  - The Railway `build:api` script builds the SDK first.
