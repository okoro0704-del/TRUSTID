# TrustID Enrollment Integrity & ANN Recall Governance V1

Status: implemented locally, not committed, not deployed. Production threshold
stays **0.35 UNCALIBRATED**. No production ANN setting was changed.

## 1. Identity creation inventory

| Path | Creates | Duplicate gate | Classification |
|---|---|---|---|
| `POST /v1/identity/register-trust-id` -> `register.ts` -> `autoEnrollFromBiometrics` -> `createBiometricIdentity` | User + TrustID + face template | Canonical gate, under enrollment lock | SAFE |
| `POST /v1/trust-id/ambient-signin` (`allowAutoEnroll`) -> `ambientSignInAndSession` -> `autoEnrollFromBiometrics` -> `createBiometricIdentity` | User + TrustID + face template | Canonical gate, under enrollment lock | SAFE |
| `POST /v1/trust-id/enroll-biometric` -> `attachBiometricTemplate` | Face/fingerprint template on the caller's own identity | Canonical gate for faces (was: legacy/low-confidence/any-model faces bypassed it) | SAFE (was BYPASSES_DUPLICATE_GATE) |
| `POST /v1/auth/fast-vector-match`, `/v1/auth/biometric-login`, `/v1/identity/face-lookup`, `/v1/trust-id/verify-biometric` (lookup / verify; `allowAutoEnroll: false` where ambient is used) | Nothing | n/a (lookup only) | SAFE |
| `POST /auth/register` (`registerIdentity`) | User + TrustID, no biometric | n/a (non-biometric; later biometric attach is gated) | SAFE |
| `POST /v1/auth/register-silent` | User + TrustID + passkey, no biometric | n/a (non-biometric; later biometric attach is gated) | SAFE |
| `services/gateway` `trustIdAuth.ts` no-match branch | Previously raw `INSERT` of an identity | Now refuses (409 `ENROLLMENT_REQUIRES_CANONICAL_GATE`) | LEGACY (unwired) |
| `services/gateway` `trustIdRegistry.ts` `/registry/enroll` | Via `ambientSignInAndSession` -> canonical gate | Canonical gate; its own pre-check still discloses the matched TrustID | LEGACY (unwired) |
| Assurance Lab (`/internal/assurance-lab/*`) | Pseudonymous lab evidence only, file store | n/a (never creates TrustIDs) | INTERNAL_ONLY |
| Test helpers (`prisma.user.create` + `enrollTemplate` in tests) | Fixtures | n/a | TEST_ONLY |

## 2. Canonical enrollment gate (`apps/api/src/modules/trust-id/enrollment-gate.ts`)

1. Entry validation (`validateFaceEnrollmentPayload`): 512-D, production model
   name, version 1, confidence >= 0.5, finite values, non-zero norm.
2. Under `withBiometricEnrollmentLock` (Postgres `pg_try_advisory_xact_lock`,
   database-wide, per face model):
   duplicate retrieval (ANN Top-K) -> exact rerank -> `assessDuplicateEnrollment`.
3. Decision: only `CLEAR` continues. `REVIEW_REQUIRED` -> 409
   `DUPLICATE_ENROLLMENT_REVIEW_REQUIRED`, `AMBIGUOUS` -> 409 `AMBIGUOUS_MATCH`,
   `SERVICE_UNAVAILABLE` -> 503. Candidates are never disclosed; an audit event
   is written.
4. Creation inside the lock; if the template write fails the new user is
   deleted (compensation) and the request fails 503.
5. Any error without an explicit status becomes 503
   `BIOMETRIC_SERVICE_UNAVAILABLE` (fail closed). An ANN failure is never CLEAR.

SQLite (local/tests only) uses a single-process queue reported as
`SINGLE_PROCESS_DEV_ONLY`; it is not a production mechanism.

## 3. Governance parameters (read-only)

`apps/api/src/modules/trust-id/retrieval-policy.ts` (pure, no database
imports) declares Top-K, ef_search, ANN timeout, threshold, ambiguity margin,
model, dimension, metric and HNSW build parameters, resolved exactly like the
production matcher (drift-guarded by `tests/retrieval-policy.test.ts`).

`GET /internal/biometric-governance/retrieval-policy` (secret header
`x-eval-biometric-secret`, 404 when unset, GET only, `no-store`) returns the
policy plus serialization backend and the database's effective defaults. It
contains no biometric data and cannot change anything.

### Finding: declared ef_search and ANN timeout are not applied

`vector-matcher.ts` `fetchAnnTopK` issues `SET LOCAL statement_timeout` and
`set_config('hnsw.ef_search', ef, true)` as separate autocommit statements.
Transaction-local settings end with their own statement, so the search runs
with database defaults. Measured on PostgreSQL 17.6 / pgvector 0.8.2:

- declared ef_search 64 -> **effective 40** (pgvector default);
- declared timeout 2000 ms -> **effective 0 (unbounded)**;
- `LIMIT 50` > ef_search 40, so the index scan returns at most 40 candidates.

Not changed (protected file; production ANN policy change requires a
governance decision on real evidence). Status constant:
`ANN_SESSION_SETTING_APPLICATION.status = NOT_APPLIED_OUTSIDE_TRANSACTION`.

## 4. Lab-only ANN recall governance

- SDK: `evaluateAnnRecallGovernance` (`@trustid/sdk/assurance-lab`).
- Runner: `scripts/assurance-lab-ann-governance.mts`
  (`--source study|synthetic`, local disposable Postgres only, refuses any
  database with TrustID tables or `NODE_ENV=production`, drops its schema).
- Configurations: `AS_IMPLEMENTED` (production call sequence verbatim) and
  `EF_n` (settings applied inside a transaction).
- Exact reference: exhaustive in-memory cosine Top-K.
- Metrics: recall@1/5/10/50 vs exact, mate recall, passing-candidate miss rate,
  short results, identification outcomes with RETRIEVAL_ERROR vs
  MATCHING_THRESHOLD_ERROR attribution, duplicate-gate detection / ambiguity /
  ANN miss / threshold rejection / service unavailable, FALSE CLEAR with Wilson
  95% CI, p50/p95/p99 latency, sequential and concurrent QPS. Timeouts count as
  SERVICE_UNAVAILABLE and never abort the run.
- FALSE CLEAR is claimable only for REAL_HUMAN evidence; synthetic results are
  labelled `SYNTHETIC_INFRA_ONLY`.

### Synthetic results (infrastructure only, not biometric accuracy)

200 gallery identities + 40 holdout, synthetic random-unit distractors,
400 returning attempts, 160 new attempts, Top-K 50, threshold 0.35.

| Gallery | Config | Mate recall@50 | FALSE CLEAR (ANN miss / threshold) | p50 / p95 ms |
|---|---|---|---|---|
| 20,200 | AS_IMPLEMENTED | 0.935 | 46/400 (21 / 25) | 33 / 87 |
| 20,200 | EF_64 | 0.980 | 31/400 (6 / 25) | 66 / 402 |
| 20,200 | EF_128+ | 1.000 | 25/400 (0 / 25) | 92 / 299 |
| 100,200 | AS_IMPLEMENTED | 0.690 | 142/400 (117 / 25) | 31 / 47 |
| 100,200 | EF_64 | 0.823 | 93/400 (68 / 25) | 39 / 87 |
| 100,200 | EF_128 | 0.978 | 33/400 (8 / 25) | 43 / 64 |
| 100,200 | EF_256 | 0.998 | 26/400 (1 / 25) | 53 / 86 |
| 100,200 | EF_512 | 1.000 | 25/400 (0 / 25) | 70 / 106 |

`AS_IMPLEMENTED` equals `EF_40` on every retrieval metric in both runs.
Uniform random distractors are a hard case for HNSW and not a face
population; magnitudes do not transfer to production. The mechanism does.
Latency was measured on Docker Desktop (Windows) and is indicative only.
Artifacts: `artifacts/assurance-lab/ann-governance/`.

## 5. Real-human readiness (dry run, synthetic only)

`apps/api/tests/real-human-readiness-dry-run.test.ts` runs the full lifecycle
in a throwaway store: exact `I CONSENT`, consent/study version, consent
document SHA-256 (recomputed), pseudonymous `lab_p_*` IDs, server-assigned
`REAL_HUMAN_CONSENTED` (client-supplied provenance rejected), raw media
refused, withdrawal removes evidence from the governance cohort, ANN
governance on collected evidence via production decision code, 30-day
retention purge before analysis, production counts unchanged.

Provenance is by collection path only: the server cannot prove a live human
was present (PAD INCOMPLETE). Dry runs must never target the real study root.

## 6. Residual risks

- Install-occupancy check runs outside the enrollment lock.
- Hot cache is keyed by userId; face and fingerprint entries overwrite each other.
- "Fingerprint" biometric is derived from a device public key, not a human trait.
- Post-creation device/master steps run outside the lock and are not compensated.
- Lock hold timeout (60 s) can end the lock transaction while the critical section still runs.
- The production HNSW index is shared with non-face rows and post-filtered by modality.
- Legacy `trustIdRegistry.ts` (unwired) discloses the matched TrustID on duplicate.
