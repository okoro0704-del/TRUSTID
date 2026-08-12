/**
 * Account recovery extension points.
 * Shamir guardian circles are implemented in service.ts.
 * Additional providers (gov ID, recovery codes) remain pluggable.
 */

export type RecoveryMethodKind =
  | "government_identity"
  | "recovery_codes"
  | "trusted_contact"
  | "shamir_guardians"
  | "manual_review";

export interface RecoveryProvider {
  kind: RecoveryMethodKind;
  /** Whether this provider is enabled for the deployment */
  enabled: boolean;
  startRecovery?(userId: string): Promise<{ challengeId: string }>;
  completeRecovery?(challengeId: string, proof: unknown): Promise<{ ok: boolean }>;
}

/** Registry — providers register at module load. */
const providers: RecoveryProvider[] = [];

export function registerRecoveryProvider(provider: RecoveryProvider) {
  providers.push(provider);
}

export function listRecoveryProviders() {
  return providers.map((p) => ({ kind: p.kind, enabled: p.enabled }));
}

export function getRecoveryArchitectureNotes() {
  return {
    status: "partial",
    extensionPoints: [
      "government_identity",
      "recovery_codes",
      "trusted_contact",
      "shamir_guardians",
      "manual_review",
    ] as RecoveryMethodKind[],
    note: "Device approval and primary-device policy are independent of recovery. Recovery must never bypass primary-device controls without a verified high-assurance path.",
  };
}
