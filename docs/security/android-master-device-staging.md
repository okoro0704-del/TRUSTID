# T3 isolated staging (plan; nothing deployed)

Goal: a hosted environment where authorized test phones can run the full T3 ceremony. Hosting is
required because passkeys and Digital Asset Links need a public HTTPS RP domain. The environment
must be unable to read or change production users, sessions, keys or enrollment state.

The local staging kit (`portal-trustid-adapter: staging/trustid-acceptance/`) already covers the
browser/Portal contract offline. It cannot serve physical phones, because phones need a real
public domain with Digital Asset Links.

## Components

| Component | Staging | Production (must not be shared) |
|---|---|---|
| Web origin / RP ID | new Netlify site, e.g. `trustid-staging.netlify.app` (the name is the owner's choice) | `trustedid.netlify.app` |
| API | separate Railway environment/service running the PR #3 commit | `lucid-integrity` (project LifeOS) |
| Database | its own Postgres + pgvector instance, disposable | `pgvector` service |
| Secrets | freshly generated: `COOKIE_SECRET`, `TRUSTID_TOKEN_KEYS`, PII pepper, seal key, OAuth client secrets | never copied to staging |
| OIDC issuer / JWKS | `https://<staging>/api`, its own `kid` | issuer `https://trustedid.netlify.app/api`, kid `263c1076162e8c26` |
| Android app | package `com.trustid.device.staging` (Gradle `applicationIdSuffix`), `CAP_SERVER_URL=https://<staging>`, signed with a **staging key** (not the release key) | `com.trustid.device` |
| Digital Asset Links | `https://<staging>/.well-known/assetlinks.json` → staging package + staging cert | release cert only (after release signing) |
| Portal | staging Portal client registered on the staging issuer | production Portal clients |

Staging API environment:

- `NODE_ENV=production`, so the staging-only `MASTER_DEVICE_ATTESTATION=off` cannot be used
  either, and the attestation path matches production.
- `MASTER_DEVICE_ENROLLMENT=enabled`.
- `ANDROID_APP_PACKAGE=com.trustid.device.staging`.
- `ANDROID_APP_SIGNING_SHA256=<staging cert>`.
- `WEBAUTHN_ANDROID_ORIGINS=android:apk-key-hash:<staging cert b64url>`.
- `WEBAUTHN_RP_ID=<staging host>`.
- `CORS_ORIGINS` and WebAuthn origins listing the staging origins only.
- `DATABASE_URL` pointing to the staging database.

## Prerequisite change (not made on this branch)

`netlify.toml` forces `/api/*` to `https://lucid-integrity-production.up.railway.app` for **every**
Netlify context. A staging site built from this repo, deploy previews included, would therefore
proxy to production.

Verified read-only on `deploy-preview-3`:

- production refuses the preview origin (`403 origin_not_allowed`) on credentialed calls;
- production has no T3 routes (`404`).

Even so, staging must not depend on production refusing it. Before any staging deploy, make the
proxy target a build-time setting:

- e.g. a build step writes `_redirects` from `TRUSTID_API_PROXY_ORIGIN`, with the production value
  only in the production context. `_redirects` takes precedence over `netlify.toml`.
- or deploy staging from a config that has no production redirect.

## Isolation evidence to collect before the first phone test

1. `GET https://<staging>/api/health`:
   - `webauthn.rpID` is the staging host;
   - `identityFoundation.oidcIssuer` is the staging issuer;
   - no production origins are listed.
2. `GET https://<staging>/api/.well-known/jwks.json` has a `kid` different from production's
   `263c1076162e8c26`.
3. The staging database host differs from production's. Confirm in the Railway variables by name,
   without printing values.
4. Production refuses staging, in both directions: requests with `Origin: https://<staging>` to
   the production API return `403`, and a production id_token is refused by the staging Portal
   (wrong issuer and keys).
5. Production `MASTER_DEVICE_ENROLLMENT` is still unset: `POST /api/v1/step-up/master-device/enrollment`
   on production returns `404` today, and `403 master_device_enrollment_disabled` once deployed.
6. Cookies are host-only on the staging domain. Staging passkeys are bound to the staging RP ID,
   so production passkeys cannot be used there and staging passkeys cannot be used in production.

## Smoke tests (staging only)

1. Health, discovery and JWKS as above.
2. Enrollment is refused before the flag is set (`403 master_device_enrollment_disabled`).
3. Set the flag on staging. Then:
   - run browser sign-in and Portal login against the staging issuer;
   - run the device-acceptance matrix (A–H) with the staging-signed app.
4. Audit check: staging audit events for the test accounts only. Nothing is written to production.

## Rollback (staging)

- Disable: unset `MASTER_DEVICE_ENROLLMENT` on staging.
- Code: redeploy the previous staging deployment.
- Data: the staging database is disposable. Drop and recreate it, and remove the test accounts.
- Production needs no rollback: nothing in this plan touches it.
