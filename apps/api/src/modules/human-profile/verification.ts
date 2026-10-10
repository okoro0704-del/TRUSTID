/**
 * Provider-neutral identity document verification contract.
 *
 * V1 registers NO provider (Dojah or otherwise). A submitted document stays
 * UNVERIFIED with provider NONE. Status may only move when a provider that is
 * registered in code authenticates its own evidence, along an allowed
 * transition, with an audit record. Nothing in TrustID claims OCR, database
 * matching, liveness or legal identity verification has occurred.
 */
import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";

export const DOCUMENT_VERIFICATION_STATUS = {
  UNVERIFIED: "UNVERIFIED",
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;

export type DocumentVerificationStatus =
  (typeof DOCUMENT_VERIFICATION_STATUS)[keyof typeof DOCUMENT_VERIFICATION_STATUS];

export const VERIFICATION_PROVIDER_NONE = "NONE";

/** Raw evidence as received from a provider callback or poll; untrusted until the provider verifies it. */
export type ProviderEvidence = {
  providerId: string;
  providerReference: string;
  payload: unknown;
  /** Provider signature / MAC over the payload, as the provider defines it. */
  signature?: string;
};

/** A decision the provider adapter has authenticated from its own evidence. */
export type AuthenticatedProviderDecision = {
  providerReference: string;
  status: Exclude<DocumentVerificationStatus, "UNVERIFIED">;
  /** Stable digest of the evidence for the audit trail; never the evidence itself. */
  evidenceDigest: string;
};

export interface DocumentVerificationProvider {
  readonly id: string;
  /**
   * Authenticate provider evidence (signature, reference ownership, freshness).
   * Returns null when the evidence cannot be authenticated.
   */
  authenticateEvidence(evidence: ProviderEvidence): Promise<AuthenticatedProviderDecision | null>;
}

const ALLOWED_TRANSITIONS: Record<string, DocumentVerificationStatus[]> = {
  UNVERIFIED: ["PENDING"],
  PENDING: ["VERIFIED", "REJECTED"],
  VERIFIED: ["EXPIRED"],
  REJECTED: [],
  EXPIRED: [],
};

const providers = new Map<string, DocumentVerificationProvider>();

/** Code-level registration only (no env or request input). V1 registers none. */
export function registerDocumentVerificationProvider(provider: DocumentVerificationProvider) {
  if (!provider.id || provider.id === VERIFICATION_PROVIDER_NONE) {
    throw new Error("A verification provider needs a real id");
  }
  providers.set(provider.id, provider);
}

export function registeredVerificationProviders(): string[] {
  return [...providers.keys()];
}

export function __clearVerificationProvidersForTests() {
  providers.clear();
}

function verificationError(code: string, statusCode: number) {
  return Object.assign(new Error(code), { code, statusCode });
}

/**
 * The only path that changes a document's verification status. Requires a
 * registered provider, evidence that provider authenticates, a matching
 * provider reference once one is bound, and an allowed transition.
 */
export async function applyProviderDecision(input: { submissionId: string; evidence: ProviderEvidence }) {
  const provider = providers.get(input.evidence.providerId);
  if (!provider) throw verificationError("verification_provider_unavailable", 503);
  const decision = await provider.authenticateEvidence(input.evidence);
  if (!decision || decision.providerReference !== input.evidence.providerReference) {
    throw verificationError("invalid_provider_evidence", 400);
  }
  const submission = await prisma.identityDocumentSubmission.findFirst({
    where: { id: input.submissionId, deletedAt: null },
  });
  if (!submission) throw verificationError("not_found", 404);
  if (submission.verificationProvider !== VERIFICATION_PROVIDER_NONE && submission.verificationProvider !== provider.id) {
    throw verificationError("provider_mismatch", 409);
  }
  if (submission.providerReference && submission.providerReference !== decision.providerReference) {
    throw verificationError("provider_reference_mismatch", 409);
  }
  if (!(ALLOWED_TRANSITIONS[submission.verificationStatus] ?? []).includes(decision.status)) {
    throw verificationError("invalid_status_transition", 409);
  }
  const updated = await prisma.identityDocumentSubmission.updateMany({
    where: { id: submission.id, verificationStatus: submission.verificationStatus, deletedAt: null },
    data: {
      verificationStatus: decision.status,
      verificationProvider: provider.id,
      providerReference: decision.providerReference,
      statusChangedAt: new Date(),
    },
  });
  if (updated.count !== 1) throw verificationError("concurrent_status_change", 409);
  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_DOCUMENT_STATUS_CHANGED,
    userId: submission.userId,
    actorType: "system",
    actorId: provider.id,
    metadata: {
      submissionId: submission.id,
      from: submission.verificationStatus,
      to: decision.status,
      provider: provider.id,
      evidenceDigest: decision.evidenceDigest,
    },
  });
  return { from: submission.verificationStatus, to: decision.status };
}
