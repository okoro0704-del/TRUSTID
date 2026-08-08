import type { IDENTITY_VERIFICATION_STATUS } from "@trustid/shared";

export type IdentityVerificationStatus =
  (typeof IDENTITY_VERIFICATION_STATUS)[keyof typeof IDENTITY_VERIFICATION_STATUS];

/**
 * Abstraction for high-assurance identity verification providers
 * (document, government ID, selfie/liveness via trusted vendor, manual review).
 *
 * Device passkey authentication MUST NOT depend on this.
 *
 * Implementations must NEVER expose to consuming applications:
 *   - face embeddings
 *   - biometric templates
 *   - raw biometric comparison data
 *   - biometric hashes
 *   - liveness signals
 *
 * Portrait image bytes stay inside TrustID private media; apps receive
 * signed assertions + access-controlled portrait references only.
 */
export interface IdentityVerificationProvider {
  readonly name: string;

  beginVerification(input: {
    userId: string;
    trustId: string;
    method: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    verificationId: string;
    status: IdentityVerificationStatus;
    providerReference?: string;
  }>;

  completeVerification(input: {
    userId: string;
    verificationId: string;
    providerPayload?: Record<string, unknown>;
  }): Promise<{
    status: IdentityVerificationStatus;
    verifiedAt?: Date;
    verificationHash?: string;
  }>;
}
