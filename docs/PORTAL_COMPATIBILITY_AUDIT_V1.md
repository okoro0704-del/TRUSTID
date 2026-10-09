# Portal compatibility audit — TrustID provider contracts v1

TrustID: branch `verify/portal-provider-contracts-v1` (contract:
`docs/PORTAL_PROVIDER_CONTRACT_V1.md`).
Portal: `LifeOS-Portal` commit `fbd960e` (`trustid-canary-readiness`), read-only
(not modified).

| # | Portal behaviour at fbd960e | TrustID v1 | Classification |
|---|---|---|---|
| 1 | Client ids `lifeos_portal_public`, `lifeos_platform_admin_public`, `lifeos_business_portal_public` (`apps/*/src/lib/api.ts`) | Registered with exactly these ids | COMPATIBLE |
| 2 | Redirect URI from `VITE_TRUSTID_REDIRECT_URI`; defaults `http://localhost:5176/callback` (portal-web), `http://localhost:5178/callback` (platform-admin), `${origin}/callback` (business) | Exact match against `https://{,admin.,business.}getlifeos.app/callback` only | PORTAL ADAPTER CHANGE REQUIRED (config: set the exact production redirect URIs in each Portal build) |
| 3 | Authorize: `response_type=code`, PKCE S256, `state` checked client-side (`auth-client.ts`) | Unchanged contract; `state` returned as is | COMPATIBLE |
| 4 | No `nonce` sent; id_token ignored | id_token issued with `aud = client_id`; `nonce` echoed when sent | PORTAL ADAPTER CHANGE REQUIRED (send `nonce`, verify id_token) |
| 5 | `scope=openid profile` (`PORTAL_AUTH_SCOPES`) | `profile` is not a TrustID scope and is dropped; step-up needs `identity.step_up` | PORTAL ADAPTER CHANGE REQUIRED (`openid identity.basic identity.step_up`) |
| 6 | Browser `fetch` to `/oauth/token` with a JSON body from the Portal origin | Accepted; CORS for the three origins, no credentials | COMPATIBLE |
| 7 | Portal web may run on `https://www.getlifeos.app` (listed in `portal-api/src/lib/origins.ts`) | Not registered (only the three exact origins) | PORTAL ADAPTER CHANGE REQUIRED (serve TrustID sign-in from the apex, or request `www` registration explicitly) |
| 8 | `POST /auth/session {accessToken}`; Portal API validates with `GET /oauth/userinfo` and uses `sub`/`trustId` | Unchanged; `sub` = TrustID = id_token `sub` | COMPATIBLE |
| 9 | Access token sealed in the Portal session and sent as `Authorization: Bearer` downstream | Step-up client routes take exactly this token | COMPATIBLE |
| 10 | `checkTrustIdAvailable()` → `GET {TRUSTID_API}/health` | `/health` unchanged | COMPATIBLE |
| 11 | Biometric step-up: `POST /v1/trust-id/verify-biometric {biometric}` + bearer, then compare `trustId` (`services/trustid-stepup.ts`) | That route is unauthenticated 1:N and mints a TrustID session; it is not step-up. Replacement `POST /v1/step-up/challenges {method:"biometric"}` + TrustID-surface verify fails closed (`503 step_up_pad_unavailable`) while PAD is INCOMPLETE | BLOCKED (PAD) |
| 12 | Master Device: `POST /v1/trust-id/master-device/verify {deviceProof}` + bearer | That route needs a TrustID cookie session and a different body, and never verifies the signature. Replacement: create → user approves on the Master Device → consume (signed approval) | PORTAL ADAPTER CHANGE REQUIRED; BLOCKED end-to-end until the TrustID app registers Master Devices and shows pending approvals |
| 13 | `checkMasterDeviceBinding()` requires a biometric pass first | v1 Master Device step-up is independent of biometric | PORTAL ADAPTER CHANGE REQUIRED (do not require biometric before Master Device while PAD is incomplete) |
| 14 | Mock headers `X-TrustID-Biometric` / `X-TrustID-Master-Device` | Not part of the TrustID contract | COMPATIBLE (Portal-local mock only; must stay disabled in production) |

## Minimal Portal change list (next phase; not done here)

1. **Config:** production `VITE_TRUSTID_REDIRECT_URI` for each app; TrustID API
   base `https://trustedid.netlify.app/api`; serve sign-in from the apex hosts.
2. **auth-client.ts (all three apps):** generate and store a `nonce` next to the
   PKCE verifier; send `nonce`; request `scope=openid identity.basic identity.step_up`;
   return the `id_token` from `exchangeCode`.
3. **portal-api `/auth/session`:** accept `{ accessToken, idToken, nonce }`; verify
   the id_token (JWKS from the discovery `jwks_uri`, `iss`, `aud` = own client
   id, `azp`, `exp`, `nonce`) and require `id_token.sub === userinfo.sub`.
4. **services/trustid-stepup.ts:** replace `verify-biometric` and
   `master-device/verify` calls with the v1 flow:
   `POST /v1/step-up/challenges` (`session_binding` from the Portal session,
   `operation_digest` from the exact operation) → poll
   `GET /v1/step-up/challenges/{id}` → `POST …/consume` → verify the approval JWT
   (`typ trustid-step-up+jwt`, `aud` = own client id, `sub`, `action`,
   `operation_digest`, `session_binding`, `exp`) and record `jti` as used.
5. **UI:** "Approve on your Master Device" waiting state with cancel
   (`POST …/cancel`); clear errors for `master_device_not_registered`,
   `challenge_expired`, denied. No biometric capture in Portal.
6. Keep `TRUSTID_AUTH_MODE=disabled` in production until TrustID ships the
   device approval UI and the change list above is verified.

## TrustID-side prerequisites still open

- TrustID app: Master Device registration flow and a pending step-up approval
  screen (`GET /v1/step-up/pending`, approve/deny). Without them no user can
  approve a Master Device challenge.
- PAD completion (and threshold calibration) before biometric step-up can
  approve anything.
- Deploying the TrustID API (creates the three clients; adds the CORS origins).
