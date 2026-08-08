import { IDENTITY_VERIFICATION_STATUS } from "@trustid/shared";
import { randomBytes } from "node:crypto";
import type { IdentityVerificationProvider } from "./types.js";

/**
 * Development-only mock provider.
 * NEVER claim this is real government/document/biometric verification.
 * Does not process or store biometric templates.
 */
export class MockIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = "mock-dev";

  async beginVerification(input: {
    userId: string;
    trustId: string;
    method: string;
    metadata?: Record<string, unknown>;
  }) {
    return {
      verificationId: `mock_${randomBytes(8).toString("hex")}`,
      status: IDENTITY_VERIFICATION_STATUS.PENDING,
      providerReference: `mock_ref_${input.trustId}`,
    };
  }

  async completeVerification(input: {
    userId: string;
    verificationId: string;
    providerPayload?: Record<string, unknown>;
  }) {
    const approve = input.providerPayload?.mockApprove === true;
    if (!approve) {
      return {
        status: IDENTITY_VERIFICATION_STATUS.FAILED,
      };
    }
    // Explicitly mock — no biometrics, no document parsing
    return {
      status: IDENTITY_VERIFICATION_STATUS.VERIFIED,
      verifiedAt: new Date(),
      verificationHash: `mock_hash_${randomBytes(16).toString("hex")}`,
    };
  }
}
