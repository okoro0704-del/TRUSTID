# TrustID V1 — Authentication & Authorization Flows

## A. Create TrustID

```text
1. PWA → POST /auth/register { firstName, lastName, phone?, email? }
2. API creates user (status: pending_verification), profile, contact_method(s)
3. API creates verification_challenge, sends OTP (dev: returned/logged)
4. Audit: identity.created
5. Client → POST /auth/verify { challengeId, code }
6. Contact marked verified; audit: identity.verified
7. Client → WebAuthn registration ceremony
   - POST /auth/webauthn/register/options
   - POST /auth/webauthn/register/verify
8. Credential + trusted device created; TrustID issued if not already
9. Session created; user status → active
10. Audit: device.registered, session.created
```

Public TrustID (`TD-…`) is generated at user creation and shown after verification + first credential.

## B. Continue with TrustID (sign-in)

```text
1. User enters identifier hint (email or phone) OR discovers via passkey
2. POST /auth/webauthn/login/options
3. Authenticator assertion
4. POST /auth/webauthn/login/verify
5. Session created; device last_active updated
6. Audit: session.created
```

No passwords. Fallback for devices without biometrics: platform authenticator PIN/passcode.

## C. Sign-out / revoke

```text
POST /auth/logout          → revoke current session
DELETE /sessions/:id       → revoke specific session
POST /sessions/revoke-all  → global revocation
```

## D. New device (incremental UX)

```text
1. New device starts WebAuthn registration while authenticated via
   pairing approval OR completes first-factor verify + passkey add.
2. POST /devices/pairing-requests (from new device)
3. Existing trusted device polls/receives pending request
4. Approve → new device may complete credential registration
5. Reject → request closed
```

V1 implements the data model + approve/reject API; push notifications are out of scope.

## E. Application authorization (OAuth 2.0 + PKCE)

```text
LifeOS (mock)
  → GET /oauth/authorize?client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256
  → User signs in to TrustID if needed
  → Consent screen for scopes
  → Redirect with ?code&state
  → POST /oauth/token (code + code_verifier + client_id)
  → access_token
  → GET /oauth/userinfo or GET /identity (Bearer)
  → LifeOS upserts local profile by TrustID sub
```

TrustID never sends: private keys, recovery secrets, OTP codes, session cookies to the app.

## F. Assurance levels

| Step | Assurance |
|------|-----------|
| Email/phone OTP | Low — contact ownership only |
| Passkey | Device-bound possession + user verification |
| Future KYC / document verify | High — not in V1 |

Contact verification ≠ government ID verification.

## G. Standards used

- WebAuthn Level 2 / Passkeys (`@simplewebauthn`)
- OAuth 2.0 Authorization Code + PKCE (RFC 6749, 7636)
- OIDC-style `userinfo` / `sub` claim (`sub` = public TrustID)
- Bearer access tokens (opaque, server-validated) for V1 simplicity

## H. Trusted device credentials (secure device sprint)

- Platform authenticator + `userVerification: required`
- Challenge purposes: `registration`, `device_addition`, `authentication`, `reauthentication`
- Device/credential status: `active` | `revoked` (separate from account status and future identity verification)
- See [DEVICE_CREDENTIALS.md](./DEVICE_CREDENTIALS.md) for counter policy and NIBSS attachment points

Correct claim after passkey success:

> The user successfully authenticated using a trusted device credential protected by the platform's user-verification mechanism.
