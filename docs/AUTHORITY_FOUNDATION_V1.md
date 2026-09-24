# TrustID Authority Foundation V1

## Boundary

TrustID authenticates a human and issues a short-lived Digi subject assertion. Digi resolves that assertion to its own `ownerId` and session. Digi Authority represents what that Digi owner delegates. A delegate remains an actor and never becomes the owner.

```text
Human -> TrustID session/passkey -> Digi subject assertion -> Digi owner session
      -> owner-authorized grant -> short-lived Digi EdDSA authority token
      -> actor -> protected service -> signature + current grant consumption -> decision/audit
```

TrustID passkeys, cookies, OAuth credentials, biometric templates, raw biometric capture, recovery material, and signing keys never enter a Digi authority token. The authority token contains a Digi owner reference (`sub`), actor, audience, exact action/resource lists, grant/version, token id, limits, approval mode, and temporal claims. It may carry an optional TrustID subject reference for authorship; it is not a TrustID credential.

## Current authority model

`AuthorityGrant` is Digi-owned and stores `ownerId`, actor type/id, audience, actions, resources, limits, conditions, approval mode, validity interval, status, version, usage count, and audit linkage. An authority token is EdDSA-signed by a Digi authority key and is cryptographically checked by `@trustid/authority-verifier` before a service calls Digi's consumption endpoint.

Services must derive action and resource from the operation they are about to perform. They must not accept an actor, action, or resource supplied by an untrusted request body as the effective authorization context.

The existing grant model supports reusable scoped tokens and one-time tokens. Reusable tokens can be consumed repeatedly only while the current grant is active and within its usage limit. One-time tokens and one-time grants are atomically consumed; later use is denied. Revocation is enforced at the Digi consumption check, so a token whose signature is still valid cannot execute after its grant is revoked.

Current decision reasons are internal codes such as `missing_token`, `malformed`, `invalid_token`, `expired`, `not_yet_valid`, `wrong_audience`, `wrong_actor`, `wrong_action`, `wrong_resource`, `revoked`, `replay`, `grant_binding_mismatch`, and `grant_unavailable_or_limit`. External services should expose a generic denial response and retain detailed reasons only in protected audit/diagnostic records.

## Ownership and self-escalation

Owner authority comes from a resolved Digi session that was created by a cryptographically verified TrustID assertion. Browser storage, device presence, creator slug, Space possession, public URLs, and actor tokens do not establish owner authority.

The authority endpoints derive the owner from the Digi session. They reject a mismatching supplied `ownerId`. A request-body `stepUpProvided` value is ignored; step-up needs server-verifiable TrustID evidence. A token request can narrow an existing grant but cannot add an action/resource or extend TTL. The reference digital-twin policy denies `authority.delegate`, ownership transfer, and security change.

Delegation chains are currently **unsupported**. The former child-grant method is fail-closed because safe chains require atomic ancestor revocation and shared-budget enforcement across every persistence backend. It must not be re-enabled until that design and its tests exist.

## Step-up integration point

The authority engine can classify a rule as owner approval/step-up required, but this V1 does not accept a generic boolean as proof. A future bridge should validate a short-lived, audience/action/resource-bound TrustID reauthentication assertion, associate it with an owner approval request, and mint a temporary narrowly scoped Digi grant. Biometric matching is not the only or required step-up method; a passkey or another appropriate TrustID reauthentication method is suitable.

## Test-only proof resource

`apps/digi-rp/tests/authority-foundation.test.ts` creates a local in-memory `test-resource:alpha` target. It proves an owner assertion, owner session, grant, EdDSA token, independent JWKS signature verification, Digi consumption, exactly one permitted read, and audit records. It separately proves denial for delete/write, beta, another actor, expiration, revocation, malformed/missing tokens, token tampering, and attempts to self-escalate. The test writes only synthetic local evidence to `artifacts/authority-foundation/decisions.json`.

## Future Digi Twin and tool gateway contract

Digi Twin is an **actor**, not a TrustID or Digi owner. It never receives a user's master credential and cannot self-authorize. Future capabilities can include `repository.read`, `repository.write`, `branch.create`, `test.run`, `build.run`, `studio.tv.program`, `studio.radio.program`, `space.create`, `space.sync`, `space.publish`, `communication.answer`, and `communication.escalate`. Sensitive capabilities include `production.deploy`, `production.delete`, `trustid.security.modify`, `authority.grant`, `secret.read`, and `financial.transfer`; these should require a server-verified owner step-up and a temporary scoped grant.

```text
Model / Digi Twin -> tool gateway -> verifier + Digi consumption
  ALLOW -> execute -> audit -> result
  DENY  -> AUTHORITY_DENIED
  STEP_UP_REQUIRED -> owner device -> TrustID reauthentication -> temporary scoped grant
```

Prompt instructions are not authorization. A model stating that it has permission has no effect. Only infrastructure verification of a valid, scoped authority decision permits execution. This repository does not implement a Digi Twin, autonomous agent, or OpenAI integration.

## Operational safety

`npm run setup` no longer installs, resets, seeds, or touches a database. It exits with an explanation. The explicitly destructive reset command is restricted to an acknowledged development-only SQLite file named `apps/api/prisma/trustid-disposable.db`; it rejects production, PostgreSQL, arbitrary SQLite paths, and missing confirmation.

The current Railway `start` command still runs Prisma `db push`, seed logic, and API startup. `db push` can alter schema and seeding can alter data on every boot. V1 does not change that production startup path because live migration/seed ownership was not verified here. Use reviewed migrations and an explicit one-off deployment migration step before considering this production-safe.

Production API startup now requires an explicit strong cookie/session secret, `PII_PEPPER`, and `SEAL_KEY`; no production CORS origins are implicit. Production Digi startup requires a strong cookie secret, an Ed25519 authority private JWK, durable owner/replay/session stores, and explicit origins. Development defaults remain local-only.

## Truthfulness

Biometric threshold remains `0.35`, `UNCALIBRATED`; PAD remains `INCOMPLETE`. Passing API or authority tests does not establish biometric recognition accuracy, liveness assurance, or production readiness.

The trust-tier package is a HMAC-SHA-256 issuer attestation with a legacy Groth16-shaped layout. It is not a Groth16 proof and not zero knowledge; its tier is public. It must not be marketed or relied on as real ZK.
