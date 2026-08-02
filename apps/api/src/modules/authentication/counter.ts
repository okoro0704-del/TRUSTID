/**
 * Signature counter handling for WebAuthn credentials.
 *
 * Behavior (documented for operators):
 * - If newCounter > storedCounter: accept and store (normal).
 * - If newCounter === 0 and storedCounter === 0: accept (many platform
 *   authenticators never increment the counter).
 * - If newCounter === storedCounter and both > 0: accept with warning audit
 *   (unusual but not an automatic lockout — sync/cloned-auth false positives).
 * - If newCounter < storedCounter: accept with warning audit, do NOT lock
 *   the account solely on this signal. Operators may investigate via audit.
 *
 * TrustID never treats counter anomalies as sole proof of compromise.
 */

export type CounterDecision =
  | { action: "accept"; warning: false }
  | { action: "accept"; warning: true; reason: "unchanged" | "rollback" };

export function evaluateSignatureCounter(
  storedCounter: bigint | number,
  newCounter: number,
): CounterDecision {
  const stored = typeof storedCounter === "bigint" ? storedCounter : BigInt(storedCounter);
  const next = BigInt(newCounter);

  if (next > stored) {
    return { action: "accept", warning: false };
  }
  if (next === 0n && stored === 0n) {
    return { action: "accept", warning: false };
  }
  if (next === stored) {
    return { action: "accept", warning: true, reason: "unchanged" };
  }
  return { action: "accept", warning: true, reason: "rollback" };
}
