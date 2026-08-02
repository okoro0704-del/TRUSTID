import { IDENTITY_VERIFICATION_STATUS } from "@trustid/shared";
import type { IdentityVerificationProvider } from "./types.js";

/**
 * Placeholder provider. Future: NIBSSIdentityVerificationProvider.
 * Does not call external identity networks and never marks users verified.
 */
export class NoopIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = "noop";

  async beginVerification(): Promise<never> {
    throw Object.assign(
      new Error(
        "Identity verification provider is not configured. Device credentials remain independent of BVN/NIBSS.",
      ),
      { statusCode: 501, code: "identity_verification_unavailable" },
    );
  }

  async completeVerification(): Promise<never> {
    throw Object.assign(
      new Error("Identity verification provider is not configured."),
      { statusCode: 501, code: "identity_verification_unavailable" },
    );
  }
}

export function defaultIdentityVerificationStatus() {
  return IDENTITY_VERIFICATION_STATUS.NOT_VERIFIED;
}
