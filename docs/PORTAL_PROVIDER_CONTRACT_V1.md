# TrustID → LifeOS Portal provider contract — v1

Status: implemented and tested on branch `verify/portal-provider-contracts-v1`.
**Not deployed.** Portal TrustID mode remains disabled.

Canonical issuer: `https://trustedid.netlify.app/api` (`OIDC_ISSUER`, unchanged).
Passkey RP identity: unchanged (`trustedid.netlify.app`).

All paths below are relative to the issuer, e.g.
`https://trustedid.netlify.app/api/oauth/token` (Netlify proxies `/api/*` to
the TrustID API).

---

## 1. OAuth clients

| client_id | type | redirect_uri (exact) | browser origin |
|---|---|---|---|
| `lifeos_portal_public` | public, PKCE S256, no secret | `https://getlifeos.app/callback` | `https://getlifeos.app` |
| `lifeos_platform_admin_public` | public, PKCE S256, no secret | `https://admin.getlifeos.app/callback` | `https://admin.getlifeos.app` |
| `lifeos_business_portal_public` | public, PKCE S256, no secret | `https://business.getlifeos.app/callback` | `https://business.getlifeos.app` |

- Registration is **database rows** (`applications`), created at API boot by
  `bootstrapPortalClients()` (`apps/api/src/lib/bootstrap-oauth-apps.ts`) from
  the code definitions in `apps/api/src/lib/portal-oauth-clients.ts`.
  **Create-only:** an existing row is never modified; a differing registration
  is logged and left as is. Nothing is created until the API is deployed.
- Allowed scopes: `openid identity.basic identity.zk_claims identity.trust_level
  identity.verification_status identity.step_up` (TrustID always adds `openid`;
  scopes outside this list, such as Portal's current `profile`, are dropped).
- Redirect URIs match **exactly** for these clients. The legacy shortcut that
  accepts `/callback` on TrustID's own origin is disabled for them.
- Authorization codes: 10 minutes, single use (atomic), bound to client and
  redirect URI, PKCE S256 required. `state` is returned unchanged; the client
  must compare it.

### Authorization request

```
GET /oauth/authorize
  ?client_id=lifeos_portal_public
  &redirect_uri=https://getlifeos.app/callback
  &response_type=code
  &scope=openid identity.basic identity.step_up
  &state=<random>
  &nonce=<random, 1-256 chars, optional but recommended>
  &code_challenge=<BASE64URL(SHA256(verifier))>
  &code_challenge_method=S256
```

### Token request (from the Portal origin; CORS without credentials)

```
POST /oauth/token
Content-Type: application/json

{ "grant_type": "authorization_code", "code": "...",
  "redirect_uri": "https://getlifeos.app/callback",
  "client_id": "lifeos_portal_public", "code_verifier": "..." }
```

`200`:

```json
{ "access_token": "<opaque>", "token_type": "Bearer", "expires_in": 3600,
  "scope": "identity.basic identity.step_up openid", "id_token": "<JWT>" }
```

Errors: `400 invalid_grant` (unknown, expired, reused code; wrong verifier,
client or redirect), `400 invalid_request`, `401 invalid_client`.

## 2. CORS

- Allowed: every origin in `CORS_ORIGINS` (TrustID's own apps, **with
  credentials**) plus the three Portal origins above (**without credentials**:
  no `Access-Control-Allow-Credentials`).
- Production drops `*`, `null`, wildcard patterns, `http://` and
  localhost/loopback entries from `CORS_ORIGINS`.
- Any other `Origin` is refused before routing: `403 {"error":"origin_not_allowed"}`.
- A request whose `Origin` is a Portal origin **never authenticates with the
  TrustID session cookie** (it is `SameSite=None`); Portal uses bearer tokens.
- CORS is not authentication: every protected route still checks its token.

## 3. OIDC id_token

Returned by `/oauth/token` whenever `openid` is granted (always, for Portal
clients). EdDSA (Ed25519), `kid` from `/.well-known/jwks.json` (the discovery
`jwks_uri`). Discovery advertises `id_token_signing_alg_values_supported:
["EdDSA"]`, `subject_types_supported: ["public"]`.

| claim | value |
|---|---|
| `iss` | `https://trustedid.netlify.app/api` |
| `sub` | canonical TrustID (`TD-…`), same as userinfo `sub` |
| `aud` | the `client_id` that redeemed the code (single audience) |
| `azp` | same `client_id` |
| `iat`, `exp` | lifetime 300 s |
| `nonce` | the authorize `nonce`, if one was sent |
| `auth_time` | start of the TrustID session that authorized the code (when known) |
| `jti` | random |

**Portal must verify:** signature against the JWKS (`alg` EdDSA), `iss` equal to
the canonical issuer, `aud` equal to its **own** client id, `azp` (if present)
equal to its own client id, `exp`, and `nonce` equal to the value it stored
before redirecting (absent if it sent none). A token for
`lifeos_portal_public` is rejected by `lifeos_platform_admin_public` and vice
versa. Reference verifier: `verifyIdToken()` in
`apps/api/src/modules/authorization/id-token.ts`.

The id_token is **not** an access token: `/oauth/userinfo` and every step-up
route reject it (`401 invalid_token`). Access tokens are opaque and checked
server-side.

## 4. Authenticated step-up

### Trust boundary

- **Portal session ≠ TrustID session.** Portal holds a TrustID OAuth access
  token (sealed in its own session). It creates a challenge and later consumes
  the approval. It never approves and never sees biometric data.
- The **subject approves on a TrustID surface** with a TrustID session: the
  TrustID app on the registered Master Device, or a TrustID-origin page for a
  1:1 face check.
- Portal binds the challenge to its own session with `session_binding`, an
  opaque SHA-256 digest that Portal computes (recommended:
  `BASE64URL(SHA256("portal-session:" + <portal session token hash>))`). TrustID
  stores it, signs it into the approval and requires the same value to
  consume. TrustID never interprets it.
- Portal binds the exact operation with `operation_digest` =
  `BASE64URL(SHA256(canonical JSON of the operation))` and recomputes it before
  acting.

### Lifecycle

```
pending ──approve (subject)──▶ approved ──consume (client, once)──▶ consumed
   │  └─deny (subject) / 3 failed attempts──▶ denied
   ├─cancel (client)──▶ cancelled          (approved can also be cancelled)
   └─expires_at passes──▶ expired (derived; pending or approved)
```

Lifetime 30–300 s (default 120 s). The approval JWT lives 60 s.

### Client routes — `Authorization: Bearer <access_token>` with scope `identity.step_up`

A TrustID session token or an id_token is rejected with `401 invalid_token`;
a token without the scope with `403 insufficient_scope`.

**`POST /v1/step-up/challenges`** → `201`

```json
{ "method": "master_device" | "biometric",
  "action": "domain.purchase",                 // ^[a-z][a-z0-9_.:-]{1,99}$
  "operation_digest": "<43-char base64url or 64-char hex SHA-256>",
  "session_binding": "<43-char base64url or 64-char hex SHA-256>",
  "ttl_seconds": 120 }                          // optional, 30-300
```

```json
{ "challenge_id": "<43-char base64url, 256-bit random>", "status": "pending",
  "method": "master_device", "action": "domain.purchase",
  "operation_digest": "...", "expires_at": "2026-10-09T12:00:00.000Z" }
```

Errors: `400 invalid_request`, `409 master_device_not_registered`,
`409 biometric_not_enrolled`.

**`GET /v1/step-up/challenges/{challenge_id}`** → `200` same shape, `status` ∈
`pending | approved | denied | cancelled | consumed | expired`. A challenge of
another subject or client is `404 challenge_not_found`.

**`POST /v1/step-up/challenges/{challenge_id}/cancel`** → `200
{"challenge_id","status":"cancelled"}`; `409 challenge_not_cancellable`.

**`POST /v1/step-up/challenges/{challenge_id}/consume`**

```json
{ "session_binding": "<same as at creation>", "operation_digest": "<same>" }
```

`200`:

```json
{ "challenge_id": "...", "status": "consumed",
  "approval": "<JWT>", "token_type": "urn:trustid:step-up-approval", "expires_in": 60 }
```

Errors: `403 session_binding_mismatch` (different access token or session
binding), `403 operation_mismatch`, `404 challenge_not_found`,
`409 challenge_not_approved` (pending, denied, cancelled, expired),
`409 challenge_already_consumed`. Mismatches do not use up the challenge.

**Approval JWT** — header `typ: "trustid-step-up+jwt"`, EdDSA, JWKS `kid`:

| claim | value |
|---|---|
| `iss` | canonical issuer |
| `aud`, `azp` | the consuming `client_id` |
| `sub` | canonical TrustID |
| `jti` | `challenge_id` |
| `action`, `operation_digest`, `session_binding` | as bound at creation |
| `method` | `master_device` or `biometric` |
| `amr` | `["hwk"]` (Master Device) or `["face"]` |
| `approved_at`, `iat`, `exp` | `exp - iat` = 60 s |
| `assurance` | biometric only: `{ "pad": "INCOMPLETE", "threshold": "UNCALIBRATED" }` |

Portal must verify signature, `typ`, `iss`, `aud`/`azp` = own client id,
`sub` = the TrustID linked to the Portal session, `action`,
`operation_digest` (recomputed from the request it is about to execute),
`session_binding` (recomputed from the current session), `exp`, and keep `jti`
single-use on its side. The approval is not a session and not an access token
(`401` on `/oauth/userinfo` and on subject routes).

### Subject routes — TrustID session (cookie, or session token as bearer)

An OAuth access token is not a session: `401`. Another subject's challenge is
`404`.

**`GET /v1/step-up/pending`** → `{ "challenges": [ { challenge_id, status,
method, action, operation_digest, expires_at, client_name, signing_payload? } ] }`
(`signing_payload` for Master Device challenges).

**`POST /v1/step-up/challenges/{challenge_id}/master-device/approve`**

```json
{ "device_fingerprint": "<hardware id the device registered with>",
  "signature": "<base64url ECDSA P-256 SHA-256 signature, DER or raw r||s>" }
```

The signature is over the exact UTF-8 `signing_payload`:

```
trustid-step-up/v1
challenge=<challenge_id>
sub=<TD-…>
client=<client_id>
action=<action>
operation=<operation_digest>
session=<BASE64URL(SHA256(session_binding))>
device=<master_device_id>
exp=<ISO-8601 expiry>
```

verified server-side with the SPKI public key the Master Device registered.
`200 {"status":"approved"}`. Errors: `400 invalid_request | wrong_method`,
`401 invalid_signature`, `403 wrong_master_device`, `409 challenge_not_pending`,
`410 challenge_expired`. Failed signatures/devices count; the third denies.

**`POST /v1/step-up/challenges/{challenge_id}/biometric/verify`**

```json
{ "biometric": { "modality": "face", "vector": [512 numbers],
  "modelName": "insightface_arcface_w600k_mbf_v1", "modelVersion": 1, "confidence": 0.95 } }
```

1:1 against the challenge subject's enrolled face (never 1:N), production
threshold (0.35, uncalibrated) unchanged. **Currently always**
`503 step_up_pad_unavailable`: presentation-attack detection is INCOMPLETE and
the payload carries no server-verifiable liveness, so biometric step-up fails
closed. When PAD is complete: `200 approved`, `401 biometric_no_match`
(counts; third denies), `400 invalid_biometric`, `422 biometric_model_version_mismatch`
and other model/template codes (do not count), `503 biometric_service_unavailable`.

**`POST /v1/step-up/challenges/{challenge_id}/deny`** → `200 {"status":"denied"}`;
`409`, `410`.

### Security and replay invariants

- Challenge ids: 256-bit random; server-side state; audit stores a hash only.
- Every transition is a compare-and-set on `status`; consume is atomic and
  happens once.
- Bound to subject, client, access token, session binding, action, operation
  digest, method, Master Device and expiry; the Master Device signs all of
  them.
- Step-up never creates a TrustID or Portal login session.
- No biometric template, vector, frame or score is returned or logged.

## 5. Portal integration example (no secrets)

```ts
// 1. Before a privileged operation (server side, Portal API)
const op = { action: "domain.purchase", domain: "example.com", years: 1 };
const operation_digest = b64url(sha256(canonicalJson(op)));
const session_binding = b64url(sha256("portal-session:" + session.tokenHash));
const c = await post(`${TRUSTID}/v1/step-up/challenges`, bearer(trustIdAccessToken),
  { method: "master_device", action: op.action, operation_digest, session_binding });
// 2. Tell the user to approve in the TrustID app; poll
//    GET /v1/step-up/challenges/{c.challenge_id} until status === "approved".
// 3. Consume and verify, then execute the operation exactly as digested
const r = await post(`${TRUSTID}/v1/step-up/challenges/${c.challenge_id}/consume`,
  bearer(trustIdAccessToken), { operation_digest, session_binding });
const { payload } = await jwtVerify(r.approval, remoteJwks, {
  issuer: "https://trustedid.netlify.app/api", audience: CLIENT_ID, typ: "trustid-step-up+jwt" });
assert(payload.sub === session.user.trustId && payload.action === op.action
  && payload.operation_digest === operation_digest && payload.session_binding === session_binding);
markJtiUsed(payload.jti);
```

## 6. Assurance limitations (explicit)

- **PAD:** INCOMPLETE. Biometric step-up fails closed (`503`). There is no
  configuration switch to bypass it.
- **Threshold:** 0.35 cosine distance, **uncalibrated** (no authorized
  evaluation dataset). Unchanged.
- **Master Device:** only as strong as device key protection (Android
  Keystore EC P-256 with biometric-gated use). Nothing in the TrustID apps
  currently calls Master Device registration or shows a step-up approval
  screen; both are needed before any user can approve (§7).
- The legacy routes `/v1/trust-id/challenges/issue`, `/challenges/approve`,
  `/master-device/verify` and `/verify-biometric` are **not** step-up: the first
  is unauthenticated, the approve/verify routes never check the signature, and
  `verify-biometric` is 1:N and mints a session. Portal must not use them.

## 7. Not provided by this change

- TrustID app UI: Master Device registration and a pending step-up approval
  screen (`GET /v1/step-up/pending` + approve/deny).
- TrustID web page for biometric step-up (blocked anyway by PAD).
- Refresh tokens for Portal (no `offline_access`); Portal re-authorizes when the
  access token (1 h) expires.
