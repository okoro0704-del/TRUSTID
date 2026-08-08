# Anti-Impersonation

## Policy

TrustID must **never** treat the following as proof that two accounts are the same person:

- same name
- same photograph (including identical content hash)
- same username

## Example

Existing:

- TID-A · John Smith · VERIFIED · verified portrait

Attacker creates:

- TID-B · John Smith · uploads photo of John Smith

Expected:

- TID-B ≠ TID-A
- TID-B is **not** auto-verified
- TID-B does **not** inherit TID-A’s portrait
- TID-B remains unverified / pending
- No private TID-A data is revealed to TID-B

## Hash collision handling

If an upload’s content hash matches another user’s portrait, TrustID may note a collision for operators — it does **not** merge accounts or transfer verification.

## Reporting

`POST /identity/impersonation-reports`

Types:

- `identity_impersonation_report`
- `portrait_misuse_report`
- `identity_conflict`

Reports are auditable (`identity.impersonation.reported`). Resolution is a human/admin workflow — never automatic merge.
