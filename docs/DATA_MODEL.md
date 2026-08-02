# TrustID V1 — Data Model

## Entity overview

```text
users 1──1 profiles
users 1──* contact_methods
users 1──* devices
devices 1──* credentials          # WebAuthn public credentials
users 1──* sessions
users 1──* authorizations
applications 1──* authorizations
authorizations *──* scopes (via authorization_scopes)
users 1──* audit_events
users 1──* recovery_methods
users 1──* device_pairing_requests
verification_challenges (ephemeral OTP state)
oauth_authorization_codes (ephemeral)
oauth_access_tokens / oauth_refresh_tokens
```

## Tables

### users

| Column | Notes |
|--------|-------|
| id | UUID PK (internal) |
| trust_id | Unique public ID `TD-XXXXXXXX` |
| status | `pending_verification` \| `active` \| `suspended` \| `deleted` |
| created_at / updated_at | Timestamps |

### profiles

| Column | Notes |
|--------|-------|
| user_id | PK/FK → users |
| first_name | Required |
| last_name | Required |

### contact_methods

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| type | `email` \| `phone` |
| value | Normalized unique among verified |
| verified_at | Null until verified |
| is_primary | Boolean |

### verification_challenges

| Column | Notes |
|--------|-------|
| id | UUID |
| contact_method_id | FK |
| code_hash | Hash of OTP |
| expires_at | Short TTL |
| attempts | Rate-limit counter |
| consumed_at | One-time use |

### devices

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| name | User-editable label |
| status | `trusted` \| `revoked` \| `pending` |
| user_agent | Optional metadata |
| platform | Optional |
| last_ip / last_location | Approximate, optional |
| last_active_at | Updated on use |
| trusted_at / revoked_at | Lifecycle |

### credentials

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| device_id | FK |
| credential_id | WebAuthn credential ID (unique) |
| public_key | COSE public key bytes |
| counter | Signature counter |
| transports | JSON array |
| aaguid | Optional |
| created_at | |

**Never store private keys or passwords.**

### sessions

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| device_id | Nullable FK |
| application_id | Nullable (null = TrustID PWA session) |
| token_hash | Hash of session secret |
| expires_at | |
| revoked_at | |
| ip / user_agent | Metadata |
| created_at / last_seen_at | |

### applications

| Column | Notes |
|--------|-------|
| id | UUID |
| client_id | Public client identifier |
| client_secret_hash | Null for public clients |
| name | e.g. LifeOS |
| type | `confidential` \| `public` |
| redirect_uris | JSON array |
| allowed_scopes | JSON array |
| status | `active` \| `disabled` |

### authorizations

User consent grants for an application.

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| application_id | FK |
| status | `active` \| `revoked` |
| granted_at / revoked_at | |
| Unique (user_id, application_id) where active | Enforced in app layer / partial unique |

### authorization_scopes

| Column | Notes |
|--------|-------|
| authorization_id | FK |
| scope | e.g. `identity.basic` |

### oauth_authorization_codes / oauth_access_tokens / oauth_refresh_tokens

Ephemeral or rotating tokens; all secrets stored hashed.

### device_pairing_requests

Architecture for device-to-device approval:

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| requesting_device_meta | JSON |
| status | `pending` \| `approved` \| `rejected` \| `expired` |
| approved_by_device_id | Nullable |
| expires_at | |

### recovery_methods

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | FK |
| type | `email` \| `phone` \| future |
| reference | Contact method id or opaque |
| status | |

### audit_events

| Column | Notes |
|--------|-------|
| id | UUID |
| user_id | Nullable (system events) |
| type | e.g. `identity.created` |
| actor_type | `user` \| `system` \| `application` |
| actor_id | Optional |
| metadata | JSON (non-secret) |
| ip / user_agent | |
| created_at | Immutable append-only |

## V1 scopes

```text
identity.basic     # TrustID public ID, display name, status
identity.profile   # First/last name
identity.email     # Verified email
identity.phone     # Verified phone
openid             # Standard OIDC subject (maps to TrustID)
offline_access     # Refresh token (optional)
```

Future (declared, not implemented as resources): `wallet.read`, `wallet.pay`, `wallet.transfer`.

## Integrity rules

- `trust_id` immutable after creation.
- Email/phone uniqueness among verified contacts.
- Revoking a device revokes associated credentials and related sessions.
- Revoking an authorization invalidates related OAuth tokens.
- Audit events are append-only.
