import { maskEmail, maskPhone, PORTRAIT_STATUS, SCOPES } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { getIdentityVerificationSummary } from "../identity-verification/service.js";
import { getVerifiedIdentityProfileView } from "../verified-identity/profile.js";

export async function getIdentityForUser(
  userId: string,
  scopes?: string[],
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profile: true,
      contactMethods: true,
    },
  });
  if (!user) return null;

  const allow = (scope: string) => !scopes || scopes.includes(scope);
  const result: Record<string, unknown> = {};

  if (allow(SCOPES.OPENID) || allow(SCOPES.IDENTITY_BASIC) || !scopes) {
    result.sub = user.trustId;
    result.trustId = user.trustId;
    result.status = user.status;
  }

  if (allow(SCOPES.IDENTITY_PROFILE) || allow(SCOPES.IDENTITY_BASIC) || !scopes) {
    result.profile = user.profile
      ? {
          firstName: user.profile.firstName,
          lastName: user.profile.lastName,
          name: `${user.profile.firstName} ${user.profile.lastName}`,
        }
      : null;
  }

  if (!scopes || allow(SCOPES.IDENTITY_EMAIL) || allow(SCOPES.IDENTITY_PHONE)) {
    const contacts = user.contactMethods
      .filter((c) => {
        if (!scopes) return true;
        if (c.type === "email") return allow(SCOPES.IDENTITY_EMAIL);
        if (c.type === "phone") return allow(SCOPES.IDENTITY_PHONE);
        return false;
      })
      .map((c) => ({
        type: c.type,
        value:
          scopes && !allow(SCOPES.IDENTITY_EMAIL) && c.type === "email"
            ? maskEmail(c.value)
            : scopes && !allow(SCOPES.IDENTITY_PHONE) && c.type === "phone"
              ? maskPhone(c.value)
              : c.value,
        verified: Boolean(c.verifiedAt),
        primary: c.isPrimary,
      }));
    if (contacts.length) result.contacts = contacts;
  }

  if (allow(SCOPES.IDENTITY_VERIFICATION_STATUS) || !scopes) {
    const vip = await getVerifiedIdentityProfileView(userId);
    result.identityStatus = vip.identityStatus;
    result.verificationLevel = vip.verificationLevel;
    result.isVerifiedIdentity = vip.isVerifiedIdentity;
    result.profileVersion = vip.profileVersion;
  }

  if (allow(SCOPES.IDENTITY_TRUST_LEVEL) || !scopes) {
    const { computeTrustLevel } = await import("../trust/service.js");
    result.trustLevel = await computeTrustLevel(userId);
  }

  if (allow(SCOPES.IDENTITY_PORTRAIT) || !scopes) {
    const vip = await getVerifiedIdentityProfileView(userId);
    result.portraitRef = vip.hasVerifiedIdentityPortrait
      ? vip.identityPortraitRef
      : null;
    result.portraitVersion = vip.hasVerifiedIdentityPortrait
      ? vip.portraitVersion
      : 0;
    result.hasVerifiedIdentityPortrait = vip.hasVerifiedIdentityPortrait;
    result.portraitStatus = vip.hasVerifiedIdentityPortrait
      ? PORTRAIT_STATUS.VERIFIED
      : PORTRAIT_STATUS.NONE;
  }

  return result;
}

export async function getDashboardIdentity(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profile: true,
      contactMethods: true,
    },
  });
  if (!user) return null;
  const identityVerification = await getIdentityVerificationSummary(userId);
  const verifiedIdentity = await getVerifiedIdentityProfileView(userId);
  return {
    trustId: user.trustId,
    status: user.status,
    profile: user.profile
      ? {
          firstName: user.profile.firstName,
          lastName: user.profile.lastName,
          name: `${user.profile.firstName} ${user.profile.lastName}`,
        }
      : null,
    contacts: user.contactMethods.map((c) => ({
      type: c.type,
      value: c.type === "email" ? maskEmail(c.value) : maskPhone(c.value),
      verified: Boolean(c.verifiedAt),
      primary: c.isPrimary,
    })),
    identityVerification,
    verifiedIdentity,
    createdAt: user.createdAt.toISOString(),
  };
}
