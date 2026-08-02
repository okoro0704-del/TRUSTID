# TrustID V1 — Threat Model

## Assets

1. User identity binding (TrustID ↔ person/contacts)
2. WebAuthn public credentials & device trust graph
3. Active sessions and OAuth tokens
4. Application authorizations / scopes
5. Audit integrity
6. Client secrets for confidential apps

## Adversaries

| Actor | Goal |
|-------|------|
| External attacker | Account takeover, session theft |
| Malicious / compromised app | Over-scoped data, credential phishing |
| Stolen device | Use existing passkey / session |
| Insider with DB access | Read PII / forge identity |

## Key threats & mitigations

| Threat | Mitigation |
|--------|------------|
| Password DB leak | No passwords |
| OTP brute force | Short TTL, attempt limits, rate limit |
| Session fixation / theft | Opaque random tokens, hashed at rest, HttpOnly cookies, revoke APIs |
| Token replay to wrong app | Audience/client binding on tokens; scoped claims |
| Open redirect OAuth | Exact redirect URI allow-list |
| Scope escalation | Server-side intersect; consent persisted |
| Credential stuffing on email | Passkey primary; OTP not sufficient alone for full login after enrollment |
| Device loss | User revoke device → credentials + sessions |
| Malicious RP requests excessive scopes | Consent UI; least-privilege defaults |
| XSS steals tokens | Prefer HttpOnly session for PWA; Bearer tokens short-lived; CSP in prod |
| Privilege via internal UUID guess | Public API uses TrustID / auth context; UUIDs not authorization |
| Audit tampering | Append-only events; no user delete API for audit |

## Explicit non-mitigations (V1)

- SIM swap / email account compromise before passkey enrollment
- Advanced phishing of WebAuthn (mitigated partly by origin binding)
- Nation-state authenticator compromise
- Full KYC / synthetic identity

## Residual risk acceptance

V1 prioritizes a clean passwordless root identity with OAuth boundaries. Stronger identity proofing, hardware attestation policies, and distributed abuse detection are deferred.
