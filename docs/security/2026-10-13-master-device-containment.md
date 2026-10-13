# Master Device trust boundary — containment release (2026-10-13)

Branch `security/master-device-containment`, three commits on top of production `7369fc0`
(Railway `LifeOS` / `lucid-integrity`, deployment `a7834861`, deployed 2026-10-12 09:29 UTC).

## 1. Production findings (read-only verification, 2026-10-13)

| # | Issue | Verdict | Evidence |
|---|---|---|---|
| 1 | A TrustID session can register its own Master Device key | **CONFIRMED EXPOSED** | `routes/trust-id.ts:557` (`POST /v1/trust-id/master-device/register`): `requireSession` only; `registerMasterDevice` upserts any `publicKey`. `step-up/service.ts:170` binds new challenges to the newest active master row; `approveWithMasterDevice` verifies against that row's key. A registered attacker key therefore approves the subject's step-ups. Route live (401 without session). The deployed web app (`/assets/index-BKL4IgRl.js`) calls it from "Requests from apps". |
| 2 | `POST /v1/trust-id/challenges/issue` unauthenticated | **CONFIRMED EXPOSED** | `routes/trust-id.ts:596`: no `requireSession`; body `{userId, action, payload}`. An unauthenticated `{}` probe reached schema validation (400) on both `trustedid.netlify.app/api` and the Railway origin. Each valid call creates a challenge and a security notification for that user id. No rate limit in the API. Exploitation needs an internal user id. |
| 3a | Legacy `/challenges/approve` and `/master-device/verify` approve without verifying a signature | **CONFIRMED EXPOSED** (session required) | `challenges.ts` stores `hashSecret(signature)`; `master-device.ts:83-99` returns `verified: true`. No server-side consumer of these results was found; the SDK exposes both, so a relying party trusting the response is exposed. |
| 3b | Step-up v1 approval (`/v1/step-up/challenges/:id/master-device/approve`, used by mybrandOS and Portal) without signature | **NOT PRESENT** | ECDSA verification against the bound device key; failures count and deny. Exposure of v1 comes only through issue 1. |
| — | Edge / WAF mitigation | **NOT MITIGATED** | No Netlify rules for these routes. The `onRequest` origin hook rejects only *disallowed* `Origin` headers; requests without `Origin` pass. The Railway origin is publicly reachable, so an edge-only block is bypassable. |
| — | Portal exposure | **CONFIRMED MITIGATED** | Portal production: `ENABLE_TRUST_ID=false`, `/api/auth/status` → `enableTrustId:false`. |

## 2. Root causes

1. Key enrollment and key use were never separated: one "register" route served terminal binding (placeholder keys) and, once step-up v1 shipped, signing-key enrollment, with only a session as authorization and no proof of possession or fresh user verification.
2. `challenges/issue` was written for a server-side caller and never got an authorization gate.
3. Legacy approval/verify stored a signature hash instead of verifying a signature (a placeholder that shipped).

## 3. Release contents (this branch)

| Commit | Change |
|---|---|
| `eaf9196` (from `27c40b1`) | Only ECDSA P-256 rows are step-up Master Devices; the legacy register route refuses to install or overwrite a signing key; terminal re-binding never supersedes one. |
| `b059c9c` (from `3241b22` + review) | `challenges/issue` needs a session, issues only for that subject, max 5 open; legacy approve verifies the enrolled key's signature over `trustid-master-challenge/v1` and is a single compare-and-set. |
| `8fb429c` (review) | `/master-device/verify` needs the enrolled key's signature over an issued pending challenge and uses it up; step-up v1 max 10 open challenges per client per subject; user-facing refusal message; tests. |

Not included (feature work, separate approval): enrollment ceremony routes, Trust Center page, `at_hash`, Portal OIDC clients changes, CI workflow, staging kit. No schema change: `prisma db push` on boot is a no-op.

**User impact.** Phones already registered as Master Devices keep approving mybrandOS step-ups. Registering a *new* phone returns "Adding a new Master Device is temporarily unavailable …" until the enrollment ceremony and Android passkey support ship. Legacy SDK callers of `challenges/issue` must authenticate; `/master-device/verify` callers must sign an issued challenge (no first-party caller found). Sign-in, OIDC discovery, JWKS and token endpoints are unchanged.

## 4. Validation (disposable databases only)

```bash
cd trustid-security-containment && npm ci && npm run build:api
cd apps/api && npx vitest run                                    # SQLite: 247 passed, 6 skipped, exit 0
# PostgreSQL + pgvector (local container trustid-test-pg)
cd ../.. && PRISMA_PROVIDER=postgresql node scripts/sync-prisma-provider.mjs && npm run db:generate -w @trustid/api
cd apps/api && TRUSTID_TEST_POSTGRES_URL=postgresql://trustid_test:trustid_test@127.0.0.1:55433/trustid_test \
  npx vitest run tests/master-device-containment.test.ts tests/step-up.test.ts tests/mybrandos-step-up.test.ts tests/portal-oidc.test.ts tests/trust-id-biometric.test.ts
                                                                  # 53 passed, exit 0
cd ../.. && node scripts/sync-prisma-provider.mjs && git checkout -- apps/api/prisma/schema.prisma
```

## 5. Deployment checklist (owner approval required at each step)

1. Push `security/master-device-containment`; open a PR to `main` labelled security; review the three commits.
2. CI: the `Portal Provider Contracts Verification` workflow triggers only on listed branches — run it with `workflow_dispatch` on this branch, or run the commands above.
3. Before merge: `pg_dump` of the TrustID production database (read path only).
4. Merge → Railway deploys `main` automatically (observed for `7369fc0`).
5. Post-deploy checks (non-destructive):
   - `curl -X POST https://trustedid.netlify.app/api/v1/trust-id/challenges/issue -H 'content-type: application/json' -d '{}'` → **401** (was 400).
   - `GET /.well-known/openid-configuration` and `/.well-known/jwks.json` → 200, unchanged.
   - A test account signs in to TrustID and to mybrandOS normally.
   - A test account with an existing phone approves one mybrandOS step-up.
6. Run the audit review (§7) and record the outcome.

## 6. Rollback

- Preferred: roll forward (fix and redeploy). No schema change to undo.
- Emergency: in Railway, redeploy deployment `a7834861` (`7369fc0`). **This re-opens all three exposures**; pair it with an owner decision to accept that window.
- Netlify web is not changed by this release.

## 7. Audit review plan (owner-run, read-only, aggregates first)

Run in `BEGIN READ ONLY;`. Start with counts; open individual rows only for flagged users, and record who looked and why. Do not export.

```sql
-- P-256 SubjectPublicKeyInfo prefix (91-byte keys): step-up-capable Master Devices, any registration date
WITH k AS (SELECT * FROM master_devices
  WHERE length(public_key) = 91
    AND substring(public_key FROM 1 FOR 26) = decode('3059301306072a8648ce3d020106082a8648ce3d030107034200','hex'))
SELECT status, count(*), min(created_at), max(updated_at) FROM k GROUP BY status;

-- Registrations since step-up v1 went live, by day, and subjects with more than one
SELECT date_trunc('day', created_at) d, count(*), count(DISTINCT user_id) FROM audit_events
 WHERE type = 'master_device.registered' AND created_at >= '2026-10-12 09:29:00+00' GROUP BY d ORDER BY d;
SELECT user_id, count(*) FROM audit_events
 WHERE type = 'master_device.registered' AND created_at >= '2026-10-12 09:29:00+00' GROUP BY user_id HAVING count(*) > 1;

-- Step-up approvals by client and action; approvals by a device registered < 1 h before approval
SELECT a.client_id, c.action, c.status, count(*), count(DISTINCT c.user_id) FROM step_up_challenges c
  JOIN applications a ON a.id = c.application_id GROUP BY 1, 2, 3 ORDER BY 1, 2;
SELECT a.client_id, c.action, count(*) FROM step_up_challenges c
  JOIN applications a ON a.id = c.application_id JOIN master_devices m ON m.id = c.master_device_id
 WHERE c.approved_at IS NOT NULL AND c.approved_at - m.updated_at < interval '1 hour' GROUP BY 1, 2;

-- Legacy (unauthenticated) challenge issuance and signature-less approvals/verifications
SELECT date_trunc('hour', created_at) h, count(*), count(DISTINCT user_id), count(*) FILTER (WHERE status = 'approved')
  FROM master_auth_challenges GROUP BY h ORDER BY h;
SELECT type, date_trunc('day', created_at) d, count(*) FROM audit_events
 WHERE type IN ('master_auth.challenge_issued', 'master_auth.challenge_approved', 'master_device.verified')
 GROUP BY 1, 2 ORDER BY 2;
-- Only if a burst appears: sources of issuance (IP is personal data; aggregate, no export)
SELECT ip, count(*) FROM audit_events WHERE type = 'master_auth.challenge_issued' GROUP BY ip ORDER BY 2 DESC LIMIT 20;

-- Device changes
SELECT status, count(*) FROM master_devices WHERE updated_at >= '2026-10-12 09:29:00+00' GROUP BY status;
```

Look for: more than one signing-key registration per subject; a registration followed by approvals within minutes; Digi Twin / likeness approvals (`mybrandos.*`) by recently registered devices; issuance bursts from few IPs; any `master_auth.challenge_approved` / `master_device.verified` (no first-party caller exists).

**Audit gaps.** `master_device.registered` has no session id or key type; legacy `challenge_issued` is recorded with `actorType: system` (the caller was unauthenticated); failed approval signatures increment a counter but are not audited; step-up denials are not audited; signature contents are not kept (hash only, by design).

**If suspicious.** Owner approves: revoke the device row (`status = 'revoked'`), revoke that subject's sessions, notify the subject, review and if needed withdraw mybrandOS Digi Twin / likeness consents granted through those approvals, preserve the audit rows.
