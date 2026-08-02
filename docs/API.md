# TrustID V1 — API Contracts

Base URL (local): `http://localhost:8787`

Unless noted, authenticated TrustID PWA routes use session cookie `trustid_session`.

OAuth resource routes use `Authorization: Bearer <access_token>`.

## Identity

### `GET /identity`

Returns the authenticated user’s identity (session or Bearer with `identity.basic`).

```json
{
  "trustId": "TD-XXXXXXXX",
  "status": "active",
  "profile": { "firstName": "Jane", "lastName": "Doe" },
  "contacts": [
    { "type": "email", "value": "j***@example.com", "verified": true }
  ]
}
```

Scoped Bearer responses omit fields not granted.

## Authentication

### `POST /auth/register`

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "phone": "+15551234567"
}
```

Response: `{ userId, trustId, challengeId, debugCode? }`  
(`debugCode` only when `NODE_ENV=development`)

### `POST /auth/verify`

```json
{ "challengeId": "...", "code": "123456" }
```

### WebAuthn

- `POST /auth/webauthn/register/options` — body: `{ userId, deviceName? }`
- `POST /auth/webauthn/register/verify` — body: credential + `userId` + `deviceName?`
- `POST /auth/webauthn/login/options` — body: `{ email? | phone? }` (optional discovery)
- `POST /auth/webauthn/login/verify` — body: assertion

### `POST /auth/session`

Bootstrap/validate current session → identity summary.

### `POST /auth/logout`

Revokes current session.

## Devices

- `GET /devices`
- `PATCH /devices/:id` — `{ name }`
- `DELETE /devices/:id` — revoke
- `POST /devices/pairing-requests`
- `GET /devices/pairing-requests`
- `POST /devices/pairing-requests/:id/approve`
- `POST /devices/pairing-requests/:id/reject`

## Applications (admin/bootstrap + listing)

- `GET /applications` — public catalog for dashboard (connection status if authed)
- `POST /applications` — register app (dev/admin; seeded LifeOS in V1)

## Authorizations

- `GET /authorizations`
- `POST /authorizations` — create/update consent (used by consent UI)
- `DELETE /authorizations/:id`

## OAuth 2.0

- `GET /oauth/authorize`
- `POST /oauth/consent`
- `POST /oauth/token`
- `GET /oauth/userinfo`
- `GET /.well-known/openid-configuration` (minimal discovery)

## Security / sessions

- `GET /security/events`
- `GET /sessions`
- `DELETE /sessions/:id`
- `POST /sessions/revoke-all`

## Errors

```json
{ "error": "invalid_request", "message": "Human readable" }
```

HTTP status codes follow conventional REST / OAuth semantics.
