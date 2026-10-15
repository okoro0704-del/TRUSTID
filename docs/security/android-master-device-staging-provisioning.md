# T3 staging — provisioning plan and preflight (approval checkpoint)

Status: **plan only. Nothing has been created, deployed, generated or configured.** Every write
below needs the owner's explicit approval. Baseline:

- PR #3 head `9636246`; all CI checks pass;
- production `main` `fc32eca`;
- production enrollment disabled (the T3 routes return 404 in production).

## Preflight findings (read-only, 2026-10-15)

| # | Finding | Impact | Needed before provisioning |
|---|---|---|---|
| P1 | ~~Blocker~~ **Resolved on this branch.** With `NODE_ENV=production` the API required the production LifeOS origin in `CORS_ORIGINS`, and every CORS origin was also a passkey origin. | — | `TRUSTID_DEPLOY_ENV=staging` + startup guard (`apps/api/src/lib/deployment-guard.ts`): staging requires explicit staging RP ID / passkey origin / CORS / issuer and refuses every production origin; passkey origins no longer include `CORS_ORIGINS` (all environments). Tests: `tests/staging-deployment.test.ts`. |
| P2 | **Resolved on this branch.** Boot created the production Portal clients and the seed upserted development/production clients. | — | Staging registers only `lifeos_*_staging_public` clients from `TRUSTID_STAGING_*_ORIGIN`; the seed creates nothing in staging; staging refuses to start if its database holds an active client redirecting to production or local hosts (nothing is modified). |
| P3 | Connected services (Elfcom, DataZone, Lidios, Digiconomy, platform-job, master-distribution) default to `unbound`; FinProv defaults to an embedded local shim. | Safe by default. | Leave every `*_MODE` unset on staging; the isolation check confirms `/health` shows them unbound. |
| P4 | OIDC / assertion signing keys are generated on first boot into the database and sealed with `SEAL_KEY`. | A fresh staging database gets its own keys automatically. | Check that the staging JWKS `kid` ≠ `263c1076162e8c26`. |
| P5 | Schema: `npm start` runs `prisma db push` (no versioned migrations) plus the seed on every boot, after `ensure-pg-extensions`. The database must be the **pgvector** template; standard Railway Postgres lacks the extension. | Staging exercises the same path as production. | Sequencing below. |
| P6 | `railway.toml` (config as code) is shared by every Railway service built from this repo. | Staging-only settings (health check path) belong in the staging service's settings, not in the repo file. | — |
| P7 | Tooling: Railway CLI 5.63.4 is logged in (owner account); no project is linked here. The Netlify CLI has a saved login but its status check hangs. `gh` is not logged in. `keytool` is absent (`openssl` is present; Android Studio's JBR includes keytool). | Earlier, writes to the Railway secret store were refused by the permission policy. Expect owner action or explicit approval for secret writes. | — |

## 1. Netlify resources

| Resource | Setting |
|---|---|
| New site in the existing team, e.g. `trustid-staging` → `https://trustid-staging.netlify.app` (the name fixes the passkey RP ID; choose once) | Repo `okoro0704-del/TRUSTID`, production branch of this site = `feat/android-master-device` (later the reviewed branch), same `netlify.toml` |
| Site environment variables (staging site only) | `TRUSTID_DEPLOY_ENV=staging`; `TRUSTID_API_PROXY_ORIGIN=https://<staging-api>.up.railway.app` |
| Deploy previews / branch deploys on the staging site | Off. They would also route to the staging API, but they aren't needed. |
| Digital Asset Links | Generated per environment at build (`scripts/netlify-asset-links.mjs`): staging → `com.trustid.device.staging` + `TRUSTID_ANDROID_SIGNING_SHA256` (required); production → `com.trustid.device` + release cert, or no file (404) until one is configured; previews → none; debug certificates refused. Set `TRUSTID_ANDROID_SIGNING_SHA256` on the staging site. |
| Production site `trustedid` | **unchanged** (still builds from `main`) |

## 2. Railway resources

A **new project** `TrustID-staging`, separate from `LifeOS`. This follows the existing `DataZone-staging`
precedent. A separate project shares no variables, private network or service references with
production.

| Resource | Setting |
|---|---|
| Service `pgvector` | Railway pgvector Postgres template (pg16 + pgvector), its own volume |
| Service `trustid-api-staging` | Same repo, branch `feat/android-master-device`, build `npm run build:api`, start `npm start` (from `railway.toml`); health check path `/health` (set in the service settings); public domain `*.up.railway.app` |
| Variables | `deploy/staging/trustid-api-staging.env.example`; `DATABASE_URL` as a reference to the staging `pgvector` service only |

**Migration sequencing:**

1. Create the `pgvector` service.
2. Set the API variables (no deploy yet).
3. First deploy: `ensure-pg-extensions` → `prisma db push` → seed → server.
4. `/health` shows `pgvector: true` and the staging issuer.
5. Confirm only the staging Portal clients exist (P2 is handled at boot).
6. Create the test accounts.

Later schema changes ship the same way, by redeploying.

## 3. Estimated recurring cost (unverified; confirm in each dashboard)

| Item | Estimate |
|---|---|
| Railway: API (≈0.5 vCPU / 0.5–1 GB) + pgvector (≈0.25–0.5 GB, 1 GB volume), always on | roughly **US$5–20 / month** in usage. The plan tier and exact rates are not visible from here. |
| Netlify: one more site in the existing team | **probably no added fixed cost**. Builds use build minutes or credits: the web build fetches biometric models and builds every package, and each staging deploy counts. Amount unknown. |
| Domains / DNS | none (platform subdomains) |

## 4. DNS

None. Staging uses `trustid-staging.netlify.app` and `*.up.railway.app`. Passkeys bind to the Netlify
host, so the name is fixed once test passkeys exist. A later custom domain would mean new passkeys
and new Digital Asset Links.

## 5. Secret generation and custody

- **Generated fresh** (≥ 32 random bytes each, by `openssl rand -base64 48` or Node `crypto.randomBytes`):
  `COOKIE_SECRET`, `SESSION_SECRET`, `PII_PEPPER`, `SEAL_KEY`, `MEDIA_SIGNING_SECRET`, `WIPE_SECRET`,
  and the database password (Railway generates it).
- **Never** copied from production, printed, logged, committed or placed in shell history. Values go
  directly into Railway variables, by one of:
  - (a) the owner pasting from a generator in the Railway dashboard; or
  - (b) a local script that generates in memory, sets via the Railway CLI with `--skip-deploys`, and
    prints only names plus an 8-character SHA-256 fingerprint. This needs an explicit approval
    because of the permission policy.
- Custody: the staging values live only in the Railway project. Recovery means rotating, not
  restoring: staging data is disposable. Access is limited to the owner's Railway account.

## 6. Android staging signing key — custody plan

- **Separate key**: never the debug key (`8e5eb294…`) and never the future production key.
- **Generated by the owner**, or by Claude with explicit approval, on the owner's machine with JBR
  `keytool`: PKCS12, EC P-256 or RSA 3072, alias `trustid-staging`, validity of 2 years or more,
  passphrase ≥ 20 random characters.
- **Storage**:
  - the keystore file is kept outside every Git working tree (Git also ignores `*.jks`, `*.keystore` and `*.p12`);
  - one encrypted backup (e.g. an encrypted archive) on owner-controlled offline media;
  - the passphrase is kept in the owner's password manager.
- **CI** (only after approval):
  - secrets `TRUSTID_STAGING_KEYSTORE_B64`, `_KEYSTORE_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`;
  - repository variables `TRUSTID_STAGING_ORIGIN` and `TRUSTID_STAGING_SIGNER_SHA256`. Once set, the
    APK verifier requires the signer to match.

  The workflow decodes the keystore into `$RUNNER_TEMP` and deletes it after the build. It never
  echoes values.
- **Compromise / retirement**:
  - remove the certificate from the staging `ANDROID_APP_SIGNING_SHA256`, `WEBAUTHN_ANDROID_ORIGINS` and Digital Asset Links;
  - delete the GitHub secrets;
  - issue a new key. Staging users reinstall.

## 7. Expected deployment configuration

- **Netlify staging site**: build command and publish directory from `netlify.toml`, with the two
  staging variables. Its `_redirects` is generated as `/api/* → https://<staging-api>/:splat 200!`.
- **Railway API**: variables per the template, with `MASTER_DEVICE_ENROLLMENT=enabled` on staging only.
- **Android**:
  - `CAP_SERVER_URL=https://trustid-staging.netlify.app npx cap sync android`;
  - `./gradlew assembleRelease -PtrustidEnv=staging -PtrustidStagingOrigin=https://trustid-staging.netlify.app` with the staging keystore;
  - `verify-android-apk.mjs --package com.trustid.device.staging --origin … --signer <staging sha256>` must pass.
- **Production**: no change of any kind.

## 8. Isolation verification plan (run before the first phone test; record evidence)

1. **Routing**:
   - the staging site's `/api/health` reaches the staging API, with the staging issuer and passkey domain;
   - production deploy previews return `/api` 404 (verified live on `deploy-preview-3`);
   - a staging build without `TRUSTID_API_PROXY_ORIGIN` fails.
2. **Identity**:
   - the staging JWKS `kid` ≠ `263c1076162e8c26`;
   - the staging issuer ≠ the production issuer;
   - a production id_token is refused by the staging Portal and API, and vice versa.
3. **Data**:
   - the staging `DATABASE_URL` references the staging `pgvector` service (compare by name);
   - the staging project has no variable referencing the `LifeOS` project;
   - `/health` lists every connected service as unbound;
   - the staging audit holds only test accounts.
4. **Passkeys**:
   - a passkey made on staging fails on production and the reverse (RP ID);
   - a production session cookie is not sent to staging (host-only).
5. **T3 ceremony** (staging, browser key with test accounts, then phones):
   - enrollment and removal are bound to the operation;
   - a removal signature expires (410) and can't be replayed;
   - an attestation with an old version, wrong time or software level is refused.
6. **App**:
   - the staging APK verifies (package, not debuggable, backup off, origin, signer);
   - an unsigned or debug APK is refused by the verifier.
7. **Production unchanged**:
   - `POST /api/v1/step-up/master-device/enrollment` on production still returns 404 (403 after a
     future deploy);
   - production variables untouched.

## 9. Rollback and deletion

- **Stop testing**: unset `MASTER_DEVICE_ENROLLMENT` on staging. Optionally pause the Netlify site
  (stop builds or unpublish).
- **Code rollback**: redeploy the previous Railway deployment, or roll back to the previous Netlify deploy.
- **Data reset**: drop and recreate the staging `pgvector` service, then redeploy the API (schema and
  seed run on boot).
- **Delete everything**: delete the Railway project `TrustID-staging` (services and volume), the
  Netlify site `trustid-staging`, and the GitHub staging secrets and variables. Retire the staging
  signing key (§6). Production needs nothing.

## 10. Actions requiring owner approval (in order)

1. Push the staging-readiness changes (implemented locally: staging trust boundary, CORS / passkey
   separation, environment-aware Digital Asset Links and OAuth bootstrap) and let CI pass.
2. Create the Railway project `TrustID-staging` with `pgvector` and `trustid-api-staging`.
3. Generate and set the staging secrets (method a or b, §5).
4. Create the Netlify site `trustid-staging` and set its two variables; first deploy.
5. First API deploy (schema push; the seed creates nothing in staging), then test accounts.
6. Generate the staging Android signing key (§6) and add the GitHub secrets and variables.
7. Enable `MASTER_DEVICE_ENROLLMENT` on **staging**.
8. Physical-device acceptance with authorized test phones (separate approval; not the OPPO phone).

## Provisioned state (Phase 1, 2026-10-15)

Phase 1 is provisioned; no application is deployed. No application secrets are set, and production is unchanged.

| Resource | ID | State |
|---|---|---|
| Railway project `TrustID-staging` (workspace "okoro0704-del's Projects") | `307d7ac3-79b6-499d-9d5c-5616188158ec` | separate project; no shared variables; no reference to `LifeOS` |
| Environment `staging` (renamed from Railway's default "production") | `6a150fe9-2a00-44f3-b5e1-a69d15c5e08d` | only environment |
| Service `pgvector` (template `3jJFCA`, image `pgvector/pgvector:pg18`, PostgreSQL 18.6) | `0c28cb27-0995-4f15-8092-10c72ebd80e3` | deployment `323502a1-09d9-4fa9-b920-b0334335b10e` SUCCESS; database credentials generated by the template |
| Volume `pgvector-volume` (`/var/lib/postgresql`, 5,000 MB) | `1c59e8cf-1623-453e-9503-c9fc20622776` | READY |
| Private endpoint `pgvector.railway.internal:5432` | network `299c972e-528b-444a-bd87-ecff3143591d` | ACTIVE / ready |
| Service `trustid-api-staging` | `63a172f0-d79a-470c-b759-dac6e87c705d` | empty: no source, no deployment, Railway variables only |

Database notes:

- The template's public TCP proxy (`altaria.proxy.rlwy.net:14947`) answered the PostgreSQL
  SSLRequest with `N` (no TLS). It was **removed**, and the endpoint now resets connections.
- The database is reachable only on the private network. `DATABASE_URL`, `PGHOST` and `PGPORT`
  were built from the proxy and no longer resolve. The API must use
  `DATABASE_URL=${{pgvector.DATABASE_URL_PRIVATE}}`.
- pgvector ships in the image. It is installed by the API's `ensure-pg-extensions` on its first
  deploy (not yet run). No application data exists.

### Production database exposure (read-only assessment, no changes made)

| Service (project `LifeOS`) | Image | Public TCP proxy | TLS on the proxy |
|---|---|---|---|
| `pgvector`: the TrustID production database (`lucid-integrity` uses `${{pgvector.DATABASE_URL_PRIVATE}}`) | `pgvector/pgvector:pg18` | **`maglev.proxy.rlwy.net:59530`** | **none**: SSLRequest answered `N`; any connection through the proxy is plaintext |
| `Postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:18` | none | n/a (private only) |

No other service or shared variable in `LifeOS` references the pgvector proxy. Consumers outside
that project (other projects, local tools, backup scripts) cannot be seen from here.

**Recommendation (owner decision):** remove the production pgvector TCP proxy after confirming that
no external consumer depends on it. Run any direct administrative access through `railway ssh` or a
TLS-terminating tunnel. Alternatively, configure TLS in the pgvector image.

## Phase 2: staging credentials (2026-10-15)

Set on `trustid-api-staging` (project `TrustID-staging`, environment `staging`). Nothing was
deployed and production is unchanged.

- `COOKIE_SECRET`, `SESSION_SECRET`, `PII_PEPPER`, `SEAL_KEY`, `MEDIA_SIGNING_SECRET`,
  `WIPE_SECRET`: each 48 random bytes (64 base64url characters), generated in memory.
- Values were passed to `railway variable set --stdin --skip-deploys`. They never appeared on a
  command line, in output, in logs or on disk. Read-back matched by SHA-256 fingerprint only.
- `DATABASE_URL=${{pgvector.DATABASE_URL_PRIVATE}}` resolves to `pgvector.railway.internal:5432`.
- Custody: the values exist only in Railway. Recovery is rotation; staging data is disposable.
- Not yet set (they need the staging web host): `NODE_ENV`, `TRUSTID_DEPLOY_ENV`, `OIDC_ISSUER`,
  `ASSERTION_ISSUER`, `WEBAUTHN_*`, `CORS_ORIGINS`, the staging Portal origins, the Android identity
  variables and `MASTER_DEVICE_ENROLLMENT`. Enrollment stays off.

## Phase 3A: staging identity foundation (2026-10-15)

No application is deployed, enrollment stays off, and production is unchanged.

| Resource | Value |
|---|---|
| Netlify site | `trustid-staging`, ID `58c5bc3d-6b56-4829-8054-1073013f5498`, account `isreal-zhbgxew`; no repo, no deploy |
| Staging web origin / passkey RP ID | `https://trustid-staging.netlify.app` / `trustid-staging.netlify.app`. Verified `*.netlify.app` certificate, TLS 1.3. `netlify.app` is on the Public Suffix List, so the RP ID is the full host. |
| Netlify build variables (staging site only) | `TRUSTID_DEPLOY_ENV=staging`, `TRUSTID_API_PROXY_ORIGIN=https://trustid-api-staging-staging.up.railway.app` |
| Railway API domain | `trustid-api-staging-staging.up.railway.app` → port 8080 (domain ID `64c62b00-050e-4f8d-a4b0-0d857ab417e5`) |

**Architecture:** same as production. The browser and the Android app talk only to
`trustid-staging.netlify.app`. Netlify proxies `/api/*` to the Railway API, keeping cookies
first-party. The API reaches `pgvector.railway.internal` over the private network.

- Issuer: `https://trustid-staging.netlify.app/api`.
- Discovery: `/api/.well-known/openid-configuration`.
- `jwks_uri`: `/api/.well-known/jwks.json`.

**Railway variables on `trustid-api-staging`:**

- Set (non-secret): `NODE_ENV=production`, `TRUSTID_DEPLOY_ENV=staging`, `PRISMA_PROVIDER=postgresql`,
  `PORT=8080`, `OIDC_ISSUER`, `ASSERTION_ISSUER`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`,
  `WEBAUTHN_ORIGIN`, `CORS_ORIGINS` (staging host only).
- Set in Phase 2: the six secrets and `DATABASE_URL=${{pgvector.DATABASE_URL_PRIVATE}}`.
- Unset by design: `MASTER_DEVICE_ENROLLMENT`, `ANDROID_APP_PACKAGE`, `ANDROID_APP_SIGNING_SHA256`,
  `WEBAUTHN_ANDROID_ORIGINS`, `TRUSTID_STAGING_*_ORIGIN`, every `*_MODE`.

The full configuration passes the real start-up guard: environment staging, the only passkey origin
is the staging host, no Portal clients, enrollment off, attestation required, every connected service
unbound.

**Website blocker (by design):** the staging Netlify build fails without
`TRUSTID_ANDROID_SIGNING_SHA256`, because Digital Asset Links require the staging signing
certificate. The staging website cannot deploy until the staging signing key exists. The API can
deploy first.

**PostgreSQL 18:** production already runs this API on the identical image
(`pgvector/pgvector:pg18`) with Prisma 6.19.3. The start-up chain is:

1. `sync-prisma-provider` (postgresql);
2. `ensure-pg-extensions` (`CREATE EXTENSION vector`);
3. `prisma db push`;
4. the seed (nothing in staging);
5. `bootstrapPgVector` (`vector(512)` and an HNSW index; needs pgvector ≥ 0.5, the pg18 image ships 0.8.x).

**First-deploy verification of private database connectivity:**

- the deploy log shows `[ensure-pg-extensions] vector extension present` and the `prisma db push`
  success (both connect via `pgvector.railway.internal`);
- `GET https://trustid-api-staging-staging.up.railway.app/health` reports `pgvector: true`, the
  staging RP ID and the staging issuer;
- the JWKS `kid` differs from production's `263c1076162e8c26`.

## Phase 3B: first staging API deployment (2026-10-15)

- Source: `okoro0704-del/TRUSTID` at `a3c74398c208211f2add9ce40f8befbca256c726` (branch head, verified
  immediately before). Only `trustid-api-staging` was connected.
- The auto-deploy trigger `27408c14-d329-4a7c-a522-e0aa7d3029bf` was deleted, so later pushes do not
  redeploy staging.
- Deployment `9bd622a7-78f3-4da4-946d-29f2b99ee89a`: **SUCCESS** (one deployment, Railpack, `railway.toml` build and start).
- Start-up log:
  - `vector extension present`;
  - Prisma connected to `pgvector.railway.internal:5432` (private) and synced the schema;
  - seed: "staging deployment, no applications seeded";
  - `[pgvector] ready: vector@0.8.7, HNSW(m=16, ef_c=64)`;
  - listening on 8080.

  No credential-bearing connection strings or token-like strings appear in the log.
- Direct endpoint `https://trustid-api-staging-staging.up.railway.app`:
  - `/health`: ok; RP ID `trustid-staging.netlify.app` (only passkey origin); issuer
    `https://trustid-staging.netlify.app/api`; `pgvector: true`; all connected services unbound
    (FinProv: embedded local shim). Biometric readiness: threshold **UNCALIBRATED** (0.35), PAD
    **INCOMPLETE**. API health is not biometric security readiness.
  - `/.well-known/openid-configuration`: issuer, `jwks_uri` and endpoints all under
    `https://trustid-staging.netlify.app/api/…`. These proxied paths go live only when the Netlify
    staging site is deployed.
  - `/.well-known/jwks.json`: kid `c455b211ea605666` (Ed25519), stable across requests, different
    from production `263c1076162e8c26`. The key persists in the staging database (volume), sealed
    with `SEAL_KEY`.
  - Master Device status, enrollment and removal routes: 401 without a session. Enrollment is off by
    configuration (`MASTER_DEVICE_ENROLLMENT` unset). The `403 master_device_enrollment_disabled`
    path needs a signed-in test session, and none was created.
  - CORS: the production origin is refused (403); the staging origin is allowed.
- Production is unchanged: API healthy, enrollment 404, JWKS kid `263c1076162e8c26`, all Railway
  deployments older than today, `lucid-integrity` still triggered only by `main`, Netlify published
  deploy from 2026-10-13.
