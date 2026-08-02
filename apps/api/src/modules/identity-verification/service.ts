import { IDENTITY_VERIFICATION_STATUS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { NoopIdentityVerificationProvider } from "./noop-provider.js";
import type { IdentityVerificationProvider } from "./types.js";

let provider: IdentityVerificationProvider = new NoopIdentityVerificationProvider();

/** Swap in a real provider later (e.g. NIBSS) without redesigning device auth. */
export function setIdentityVerificationProvider(next: IdentityVerificationProvider) {
  provider = next;
}

export function getIdentityVerificationProvider() {
  return provider;
}

export async function getIdentityVerificationSummary(userId: string) {
  const latest = await prisma.identityVerification.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) {
    return {
      status: IDENTITY_VERIFICATION_STATUS.NOT_VERIFIED,
      provider: null,
      method: null,
      verifiedAt: null,
    };
  }

  return {
    status: latest.status,
    provider: latest.provider,
    method: latest.method,
    verifiedAt: latest.verifiedAt?.toISOString() ?? null,
  };
}
