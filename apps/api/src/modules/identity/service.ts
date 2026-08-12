import { maskEmail, maskPhone, PORTRAIT_STATUS, SCOPES } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { getIdentityVerificationSummary } from "../identity-verification/service.js";
import { getVerifiedIdentityProfileView } from "../verified-identity/profile.js";
import { openSessionPresentation } from "../sessions/presentation.js";

function legacyPiiAllowed(scopes?: string[]) {
  if (!scopes) return config.allowLegacyPiiScopes;
  return config.allowLegacyPiiScopes;
}

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
    // Prefer nullifier-style sub for ZK apps; trustId only for basic when not ZK-only
    result.sub = user.trustId;
    result.trustId = user.trustId;
    result.status = user.status;
  }

  if (allow(SCOPES.IDENTITY_ZK_CLAIMS) || allow(SCOPES.IDENTITY_TRUST_LEVEL)) {
    result.zk = {
      available: true,
      provePath: "/zk/prove",
      verifyPath: "/zk/verify",
      verificationKeyPath: "/zk/verification-key",
    };
  }

  // Zero-PII default: never return profile/email/phone/portrait unless break-glass
  if (legacyPiiAllowed(scopes)) {
    if (allow(SCOPES.IDENTITY_PROFILE) || allow(SCOPES.IDENTITY_BASIC) || !scopes) {
      result.profile = null;
      result.profileNote =
        "Plaintext profile names are not stored; use session presentation or ZK claims.";
    }

    if (!scopes || allow(SCOPES.IDENTITY_EMAIL) || allow(SCOPES.IDENTITY_PHONE)) {
      result.contacts = [];
      result.contactsNote =
        "Contact plaintext is not stored at rest; contacts omitted from userinfo.";
    }

    if (allow(SCOPES.IDENTITY_PORTRAIT) || !scopes) {
      result.hasVerifiedIdentityPortrait = false;
      result.portraitRef = null;
      result.portraitNote =
        "Portrait bytes require explicit identity.portrait + ALLOW_LEGACY_PII_SCOPES.";
    }
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

  if (
    legacyPiiAllowed(scopes) &&
    (allow(SCOPES.IDENTITY_PORTRAIT) || !scopes)
  ) {
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

export async function getDashboardIdentity(
  userId: string,
  sessionId?: string,
) {
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

  let profile: {
    firstName: string;
    lastName: string;
    name: string;
  } | null = null;
  let contacts: {
    type: string;
    value: string;
    verified: boolean;
    primary: boolean;
  }[] = [];

  if (sessionId) {
    const presentation = await openSessionPresentation(sessionId);
    if (presentation) {
      const firstName = presentation.firstName ?? "";
      const lastName = presentation.lastName ?? "";
      const name =
        presentation.name ??
        (`${firstName} ${lastName}`.trim() || user.trustId);
      profile = {
        firstName,
        lastName,
        name,
      };
      if (presentation.contactType && presentation.contactValue) {
        contacts = [
          {
            type: presentation.contactType,
            value:
              presentation.contactType === "email"
                ? maskEmail(presentation.contactValue)
                : maskPhone(presentation.contactValue),
            verified: true,
            primary: true,
          },
        ];
      }
    }
  }

  return {
    trustId: user.trustId,
    status: user.status,
    profile,
    contacts,
    identityVerification,
    verifiedIdentity,
    createdAt: user.createdAt.toISOString(),
    zeroPii: true,
  };
}
