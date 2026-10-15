# T3 staging — provisioning plan and preflight (approval checkpoint)

Status: **plan only. Nothing has been created, deployed, generated or configured.** Every write
below needs the owner's explicit approval. Baseline:

- PR #3 head `9636246`; all CI checks pass;
- production `main` `fc32eca`;
- production enrollment disabled (the T3 routes return 404 in production).

## Preflight findings (read-only, 2026-10-15)

| # | Finding | Impact | Needed before provisioning |
|---|---|---|---|
| P1 | **Blocker.** With `NODE_ENV=production` the API refuses to boot unless `CORS_ORIGINS` includes the production LifeOS origin `https://lifeosapp.getlifeos.app` (`apps/api/src/lib/config.ts` `assertCanonicalLifeOsCors`, called from `app.ts:46`). WebAuthn origins also include every CORS origin. | Staging would have to trust a production web origin. Running `NODE_ENV≠production` is not acceptable either: it re-enables development fallbacks (default secrets, attestation `off`). | A small, reviewed code change: e.g. `TRUSTID_DEPLOY_ENV=staging` replaces the canonical-origin requirement with "no production origins allowed", with tests. **Owner approval to implement.** |
| P2 | On every boot the API creates the LifeOS Portal public clients (`lifeos_portal_public`, `lifeos_platform_admin_public`, business) **with production redirect URIs**. The seed also upserts `lifeos` / `digiconomy` / `lidios` clients. | No path to production: codes and keys are staging's own, and production verifies its own issuer and keys. But staging would hold clients that redirect to production domains. | After the first boot, disable those clients **in the staging database** and register a staging Portal client with staging redirect URIs. Or make the bootstrap environment-aware (code change). |
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
| Digital Asset Links | The repo's `assetlinks.json` names the production package and debug certificate. The staging site must serve **staging** statements (`com.trustid.device.staging` + staging cert). That needs an environment-aware assetlinks file, generated at build like `_redirects`. Small code change; included in the P1 change request. |
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
5. Staging data fixes (P2).
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

1. Implement and push the staging-readiness code changes:
   - P1 (staging CORS without production origins);
   - environment-aware Digital Asset Links;
   - optionally, environment-aware OAuth client bootstrap (P2).
2. Create the Railway project `TrustID-staging` with `pgvector` and `trustid-api-staging`.
3. Generate and set the staging secrets (method a or b, §5).
4. Create the Netlify site `trustid-staging` and set its two variables; first deploy.
5. First API deploy (schema push and seed), then the staging data fixes (P2) and test accounts.
6. Generate the staging Android signing key (§6) and add the GitHub secrets and variables.
7. Enable `MASTER_DEVICE_ENROLLMENT` on **staging**.
8. Physical-device acceptance with authorized test phones (separate approval; not the OPPO phone).
