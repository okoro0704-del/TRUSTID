# Verified Identity

## TrustID = WHO · Applications = WHAT

TrustID is the authoritative identity presentation layer for the ecosystem.

| Layer | Owns |
|-------|------|
| **TrustID** | Who the person is — TrustID, display name, verification state, verified portrait |
| **LifeOS / HospitalityOS / Digiconomy / Token Network** | What the person can do — bookings, roles, wallets, app data |

There is **no shared database** across products. Applications consume **signed identity assertions** and scoped userinfo — they do not redefine identity.

## What is NOT identity proof

The following are **inputs or labels**, never proof of identity by themselves:

- name
- email
- phone number
- uploaded photograph
- username / social handle

## VerifiedIdentityProfile

TrustID owns `VerifiedIdentityProfile`:

- `trustId`, `displayName`
- `identityStatus` — `unverified` | `pending` | `verified` | `revoked` | `suspended`
- `verificationLevel` / `verificationMethod`
- `identityPortraitRef` (only when verified)
- `portraitVersion`, `profileVersion`
- `issuedAt`, `updatedAt`, `status`, `revokedAt`

Application-specific profile fields (loyalty, preferences, menus) stay in those apps.

## Profile presentation

Applications must distinguish:

| State | UI example |
|-------|------------|
| Verified identity | John Smith · **Verified Identity** |
| Unverified | John Smith · **Identity not verified** |
| Pending | John Smith · **Verification pending** |
| Revoked | John Smith · **Verification revoked** |

Never show a verification badge merely because a photograph was uploaded.

## Not production-ready without

- A real `IdentityVerificationProvider` (document / government / approved vendor)
- Privacy & legal review for portrait retention
- Production private object storage (not local disk)
- Security review of assertion issuance and media signed URLs
