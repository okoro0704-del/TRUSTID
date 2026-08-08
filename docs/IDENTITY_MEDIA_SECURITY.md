# Identity Media Security

## Storage

Verified and unverified portraits use a **private media abstraction**:

- Local private directory by default (`TRUSTID_MEDIA_ROOT` / `apps/api/data/private-media`)
- Production should use private object storage (S3/R2/etc.) with no public ACLs

Portraits are **not** placed in public buckets.

## Access

Retrieval requires a short-lived HMAC media token:

`GET /identity/media/:mediaId?token=...`

Controls:

- path traversal blocked
- token bound to `mediaId`, subject `userId`, and `audience`
- short TTL (≈90–120s)
- `Cache-Control: private, no-store`

## Authorization

| Caller | Can see |
|--------|---------|
| Portrait owner (session) | Own uploads + verified |
| App with `identity.portrait` | **Verified only** |
| Unauthenticated | Nothing |

## Threats covered

- IDOR / cross-user media access
- public media exposure
- signed URL abuse (expiry + HMAC)
- media traversal
- stale verified refs (version + revoke)

## Production requirements

- Dedicated private bucket / KMS
- Token secret rotation (`MEDIA_SIGNING_SECRET`)
- Retention & deletion policy
- Security + privacy review before enabling real ID verification
