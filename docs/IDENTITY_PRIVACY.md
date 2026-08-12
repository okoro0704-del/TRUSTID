# Identity Privacy

## Zero-PII at rest

TrustID does **not** store plaintext names, emails, phones, or unencrypted identity portraits.

- Contacts: `lookupHash` + `commitment` + `salt`
- Names: `nameCommitment` only
- Portraits / assertion keys: AES-GCM sealed (`SEAL_KEY`)
- Session secrets: keyed HMAC hashes only

See [ZK_IDENTITY.md](./ZK_IDENTITY.md).

## Biometric isolation

Biometric information must remain inside TrustID (or an approved verification vendor under TrustID’s control).

**Do not expose** to LifeOS, HospitalityOS, Digiconomy, or Token Network:

- face embeddings
- biometric templates
- raw biometric comparison data
- biometric hashes
- liveness signals

Applications receive **ZK claims** and optional (legacy, break-glass) **access-controlled portrait references** only.

## Logging

Never log:

- passwords / session secrets
- private keys / JWKs private material
- biometric information
- raw identity documents
- full portrait bytes
- plaintext email/phone (log `lookupHash` prefixes only)

Audit events record identifiers and status transitions only.

## WHO / WHAT

Identity belongs to the person. The verified portrait belongs to that TrustID. Applications consume ZK proofs; they do not redefine identity.
