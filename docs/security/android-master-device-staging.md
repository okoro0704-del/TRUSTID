# T3 isolated staging (foundation ready locally; nothing created or deployed)

Goal: a hosted environment where authorized test phones run the full T3 ceremony. Passkeys and
Digital Asset Links need a public HTTPS RP domain, so this cannot stay local. The environment must
be unable to read or change production users, sessions, keys or enrollment state.

The local kit (`portal-trustid-adapter: staging/trustid-acceptance/`) already covers the browser
and Portal contract offline. Phones need the hosted environment below.

## Architecture

```
Test phone (com.trustid.device.staging, staging-signed, not debuggable)
   │ loads https://<staging-host>  (Capacitor live shell; Gradle refuses any other origin)
   ▼
Netlify site "trustid-staging"  ──  /api/* ──► _redirects (generated: TRUSTID_DEPLOY_ENV=staging)
   │  /.well-known/assetlinks.json → com.trustid.device.staging + staging cert
   ▼
Railway: TrustID API (staging service / environment, PR #3 commit)
   │  NODE_ENV=production, MASTER_DEVICE_ENROLLMENT=enabled, own secrets, own issuer/JWKS
   ▼
Railway: staging PostgreSQL + pgvector (disposable)       Staging Portal → staging issuer only
```

| Component | Staging | Production (must not be shared) |
|---|---|---|
| Web origin / RP ID | new Netlify site, e.g. `trustid-staging.netlify.app` (name is the owner's choice) | `trustedid.netlify.app` |
| API | separate Railway service/environment running the reviewed commit | `lucid-integrity` (project LifeOS) |
| Database | its own Postgres + pgvector, disposable | `pgvector` service |
| Secrets | fresh: `COOKIE_SECRET`, `SESSION_SECRET`, `PII_PEPPER`, `SEAL_KEY`, `MEDIA_SIGNING_SECRET`, `WIPE_SECRET`; OIDC signing keys generated on first boot (sealed with `SEAL_KEY`) | never copied |
| OIDC issuer / JWKS | `https://<staging>/api`, its own `kid` | `https://trustedid.netlify.app/api`, kid `263c1076162e8c26` |
| Android app | `com.trustid.device.staging`, staging key, live shell = staging origin, OTA from the staging origin | `com.trustid.device` |
| Digital Asset Links | staging site → staging package + staging cert | release cert only (after release signing) |
| Test accounts | dedicated staging accounts only (no real users, no production data import) | — |
| Audit | staging database `audit_events`; reviewed per test run | — |

API settings: `deploy/staging/trustid-api-staging.env.example` (names and policy, no values).
Provisioning plan, preflight findings and approval checkpoint: `android-master-device-staging-provisioning.md`.

## What is implemented (local, tested)

1. **Netlify API routing per environment** (`scripts/netlify-api-routing.mjs`, run by the Netlify
   build command). `netlify.toml` names no API; `/api/*` answers 404 unless the generated
   `_redirects` routes it:
   - production site (`SITE_NAME=trustedid`, `CONTEXT=production`) → the production API only;
     any other `TRUSTID_API_PROXY_ORIGIN` fails the build;
   - `TRUSTID_DEPLOY_ENV=staging` → `TRUSTID_API_PROXY_ORIGIN`. It is required, must be https, and
     the production API and production site hosts are refused. Setting it on the production site
     fails the build;
   - deploy previews / branch deploys → no API, or `TRUSTID_PREVIEW_API_ORIGIN` (never production);
   - any other site or context → the build fails.
2. **Android staging build**:
   - `-PtrustidEnv=staging -PtrustidStagingOrigin=https://<host>` produces
     `com.trustid.device.staging`, with the OTA manifest taken from the staging origin;
   - the build fails without a staging origin, with the production origin, or when the Capacitor
     shell is not synced to the staging origin;
   - production release builds must load the production origin.
3. **APK verifier** (`scripts/verify-android-apk.mjs`): checks package, not debuggable, backup
   disabled, web-shell origin, and the signer once a staging certificate exists.
4. **CI job** "Android unit tests + staging release identity": Android unit tests, a staging
   release build and the APK verifier. The signer check runs once
   `vars.TRUSTID_STAGING_SIGNER_SHA256` and the staging keystore secrets exist.

## Build commands (when staging exists)

```
cd apps/device && CAP_SERVER_URL=https://<staging-host> npx cap sync android
cd android && ./gradlew assembleRelease -PtrustidEnv=staging -PtrustidStagingOrigin=https://<staging-host>
node scripts/verify-android-apk.mjs app/build/outputs/apk/release/app-release.apk \
  --package com.trustid.device.staging --origin https://<staging-host> --signer <staging cert sha256>
```

Signing uses `TRUSTID_RELEASE_KEYSTORE*` set to the **staging** keystore. It is a different key
from the production release key.

## Isolation: how to prove staging cannot touch production

Run before the first phone test and record the results:

1. **Routing**: the staging site's `/_redirects` names only the staging API. The production
   site's `/_redirects` names only the production API. A production deploy preview answers
   `/api/health` with 404.
2. **Identity**: on `GET https://<staging>/api/health`:
   - `webauthn.rpID` is the staging host;
   - `oidcIssuer` is the staging issuer;
   - no production origins are listed.

   The staging JWKS `kid` differs from production's `263c1076162e8c26`.
3. **Data**: the staging `DATABASE_URL` host differs from production's. Compare by name in
   Railway, without printing values. Staging has no network path or credentials to the production
   database.
4. **Cross-environment refusal**:
   - the production API refuses `Origin: https://<staging>` (403);
   - the staging Portal refuses a production id_token (issuer and keys);
   - a production session cookie is not sent to the staging host (host-only cookies);
   - production passkeys do not work on the staging RP ID, and staging passkeys do not work on
     the production RP ID.
5. **Production unchanged**: production `MASTER_DEVICE_ENROLLMENT` is unset. Today
   `POST /api/v1/step-up/master-device/enrollment` returns 404; after this branch is deployed it
   returns `403 master_device_enrollment_disabled`.
6. **App**: `verify-android-apk.mjs` passes for the staging APK, and the production package name
   is refused for it.

## Local isolation results (this branch, no cloud)

| Check | Result |
|---|---|
| Routing unit tests (production, staging, previews, missing config, CLI, `netlify.toml`) | 6/6 pass |
| Staging Gradle build: no origin / production origin / unknown env / shell not synced | each fails the build |
| Production release with a preview shell | fails the build |
| Staging release APK | `com.trustid.device.staging`, not debuggable, backup off, loads the staging origin |
| Staging APK checked as production | refused (package and origin) |
| Debug APK | refused (debuggable; debug signer `8e5eb294…`) |

## Smoke tests (staging only)

1. Health, discovery and JWKS as above.
2. Enrollment is refused before the flag is set (`403 master_device_enrollment_disabled`).
3. Flag set on staging. Then run browser sign-in, Portal login against the staging issuer, and the
   device-acceptance matrix with the staging-signed app.
4. Audit check: the staging audit has events for test accounts only, and nothing is written to
   production.

## Rollback (staging)

- Disable: unset `MASTER_DEVICE_ENROLLMENT` on staging.
- Code: redeploy the previous staging deployment.
- Data: drop and recreate the disposable staging database.
- Production needs no rollback: nothing in this plan touches it.
