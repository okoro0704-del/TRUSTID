# TrustID V1 — Architecture

## Purpose

TrustID is an **independent Identity and Trust Infrastructure** service. It is the root consumer identity for the ecosystem. Applications (LifeOS, Digiconomy, and others) authenticate users through TrustID and receive **scoped authorization**, never master credentials.

**Core principle:** One person → one TrustID → multiple applications.

## Non-goals (V1)

TrustID does **not** implement LifeOS, Digiconomy, Token Network, wallets, marketplaces, social features, or business operational data (reservations, orders, property management, etc.).

## High-level topology

```text
                         TRUSTID
                    Identity + Trust
                           |
             ┌─────────────┼─────────────┐
             |             |             |
          LIFEOS       DIGICONOMY    OTHER APPS
```

```text
User
 ↓
TrustID (authenticate + authorize)
 ↓
Scoped credential / token
 ↓
Application (own profile + session)
```

## System components

| Component | Responsibility |
|-----------|----------------|
| `apps/web` | TrustID PWA — registration, verification, passkeys, dashboard |
| `apps/api` | Identity service API — auth, devices, sessions, OAuth, audit |
| `apps/mock-lifeos` | Demo relying party using OAuth 2.0 + PKCE |
| `packages/shared` | Shared types, scope constants, TrustID ID helpers |

### API internal modules

```text
apps/api/src/
  modules/
    identity/        # Users, profiles, TrustID identifiers
    authentication/  # Register, verify, WebAuthn, session bootstrap
    devices/         # Trusted devices, revoke, naming
    credentials/     # WebAuthn credential storage (public keys only)
    sessions/        # Session lifecycle, global revoke
    applications/    # Registered OAuth clients
    authorization/   # OAuth 2.0 code + token, scopes, consent
    audit/           # Security / audit events
    recovery/        # Recovery method stubs for later phases
  db/                # Prisma client + schema
  lib/               # Crypto, config, errors, middleware
```

## Identity model

- Internal primary key: opaque UUID (`users.id`) — **never** exposed as the user’s TrustID.
- Public identifier: `TD-XXXXXXXX` (Crockford Base32, random, unique, stable, non-editable).
- Contact methods (email/phone) are attributes used for verification and recovery paths — **not** primary keys.
- Profiles hold minimal display data (first/last name).

## Authentication model

1. **Contact verification** — OTP over email/phone (low assurance; architecture allows stronger KYC later).
2. **Passwordless credentials** — WebAuthn / passkeys (device-bound public-key credentials). No password store.
3. **Sessions** — Server-side sessions after successful WebAuthn assertion; revocable, expiring, tied to user + device.
4. **Application access** — OAuth 2.0 Authorization Code + PKCE; access tokens are scoped and short-lived.

Devices without biometrics use platform PIN/passcode via the authenticator; TrustID never stores those secrets.

## Device trust

- First successful passkey registration creates a trusted device record linked to the credential.
- Users can list, rename, and revoke devices.
- **New-device approval (architecture-ready):** `device_pairing_requests` supports pending approval from an existing trusted device (UX can be completed incrementally).

## Application authorization

Registered applications receive `client_id` / `client_secret` (confidential clients) or public PKCE clients (SPA mock LifeOS).

Flow:

```text
App → TrustID /oauth/authorize
User authenticates (existing session or WebAuthn)
User consents to requested scopes
TrustID issues authorization code
App exchanges code → access token (+ optional refresh)
App calls /identity (or userinfo) with token → scoped claims only
App creates its own domain user keyed by TrustID public ID
```

## Session types

| Session | Purpose |
|---------|---------|
| TrustID user session | Cookie-backed session for the TrustID PWA |
| OAuth access token | Bearer token for APIs on behalf of a user + application |
| Application session | Owned entirely by the relying party (e.g. LifeOS) — out of TrustID scope |

## Data ownership boundary

TrustID stores: identity, credentials (public), devices, sessions, app registrations, authorizations, scopes, audit events, recovery method metadata.

TrustID does **not** store: LifeOS business data, Digiconomy commerce data, reservations, orders, wallets, tokens.

## Deployment notes (V1)

- Local: SQLite via Prisma (zero external deps); schema compatible with PostgreSQL for production.
- WebAuthn requires a secure context (`localhost` or HTTPS) and configured RP ID / origin.
- Secrets (OTP codes, client secrets, session tokens) are hashed at rest; only public WebAuthn keys are stored.

## Independence rules (mandatory)

1. Independent from LifeOS  
2. Independent from Digiconomy  
3. Independent from Token Network  
4–8. No business operational data of ecosystem apps  
9. Apps receive scoped authorization only  
10. Prefer OAuth 2.0 / OIDC patterns and WebAuthn over custom crypto protocols  
