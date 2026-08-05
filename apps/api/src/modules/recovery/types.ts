/**
 * Future account recovery extension points.
 * Do NOT implement recovery flows here yet.
 *
 * Planned providers may include:
 * - Government identity verification (e.g. NIBSS/BVN)
 * - Recovery codes
 * - Trusted contacts
 * - Manual review / support escalation
 */

export type RecoveryMethodKind =
  | "government_identity"
  | "recovery_codes"
  | "trusted_contact"
  | "manual_review";

export interface RecoveryProvider {
  kind: RecoveryMethodKind;
  /** Whether this provider is enabled for the deployment */
  enabled: boolean;
  startRecovery?(userId: string): Promise<{ challengeId: string }>;
  completeRecovery?(challengeId: string, proof: unknown): Promise<{ ok: boolean }>;
}

/** Reserved registry — empty until a provider is enabled. */
const providers: RecoveryProvider[] = [];

export function registerRecoveryProvider(provider: RecoveryProvider) {
  providers.push(provider);
}

export function listRecoveryProviders() {
  return providers.map((p) => ({ kind: p.kind, enabled: p.enabled }));
}

export function getRecoveryArchitectureNotes() {
  return {
    status: "not_implemented",
    extensionPoints: [
      "government_identity",
      "recovery_codes",
      "trusted_contact",
      "manual_review",
    ],
    note: "Device approval and primary-device policy are independent of recovery. Recovery must never bypass primary-device controls without a verified high-assurance path.",
  };
}
