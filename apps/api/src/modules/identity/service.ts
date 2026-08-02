import { maskEmail, maskPhone, SCOPES } from "@trustid/shared";
import { prisma } from "../../db/client.js";

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
    createdAt: user.createdAt.toISOString(),
  };
}
