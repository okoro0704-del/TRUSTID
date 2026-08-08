# Identity Privacy

## Biometric isolation

Biometric information must remain inside TrustID (or an approved verification vendor under TrustID’s control).

**Do not expose** to LifeOS, HospitalityOS, Digiconomy, or Token Network:

- face embeddings
- biometric templates
- raw biometric comparison data
- biometric hashes
- liveness signals

Applications receive **identity assertions** and optional **access-controlled portrait references** only.

## Logging

Never log:

- passwords / session secrets
- private keys / JWKs private material
- biometric information
- raw identity documents
- full portrait bytes

Audit events record identifiers and status transitions only.

## WHO / WHAT

Identity belongs to the person. The verified portrait belongs to that TrustID. Applications consume it; they do not redefine it.
