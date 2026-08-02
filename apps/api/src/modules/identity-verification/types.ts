import type { IDENTITY_VERIFICATION_STATUS } from "@trustid/shared";

export type IdentityVerificationStatus =
  (typeof IDENTITY_VERIFICATION_STATUS)[keyof typeof IDENTITY_VERIFICATION_STATUS];

/**
 * Abstraction for future high-assurance identity verification providers
 * (e.g. NIBSS/BVN). Device authentication MUST NOT depend on this.
 *
 * Implementations must never accept or return biometric templates,
 * fingerprints, face images, or Secure Enclave private keys.
 */
export interface IdentityVerificationProvider {
  readonly name: string;

  /**
   * Start a verification ceremony for a TrustID user.
   * V1 providers may throw "not implemented".
   */
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

  /**
   * Complete or poll a verification. Must not fabricate success.
   */
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
