import {
  AUDIT_EVENTS,
  IDENTITY_STATUS,
  PORTRAIT_STATUS,
  VERIFICATION_LEVELS,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";

export async function ensureVerifiedIdentityProfile(userId: string) {
  const existing = await prisma.verifiedIdentityProfile.findUnique({
    where: { userId },
  });
  if (existing) return existing;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user) {
    throw Object.assign(new Error("User not found"), {
      statusCode: 404,
      code: "not_found",
    });
  }

  const created = await prisma.verifiedIdentityProfile.create({
    data: {
      userId: user.id,
      trustId: user.trustId,
      displayCommitment: user.profile?.nameCommitment ?? null,
      identityStatus: IDENTITY_STATUS.UNVERIFIED,
      verificationLevel: VERIFICATION_LEVELS.NONE,
      profileVersion: 1,
      portraitVersion: 0,
      status: "active",
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_PROFILE_CHANGED,
    userId,
    actorType: "system",
    actorId: userId,
    metadata: { action: "profile_initialized", profileVersion: 1 },
  });

  return created;
}

export async function bumpProfileVersion(
  userId: string,
  patch: {
    identityStatus?: string;
    displayCommitment?: string | null;
    verificationLevel?: string;
    verificationMethod?: string | null;
  } = {},
) {
  const profile = await ensureVerifiedIdentityProfile(userId);
  return prisma.verifiedIdentityProfile.update({
    where: { userId },
    data: {
      ...patch,
      profileVersion: profile.profileVersion + 1,
    },
  });
}

export async function syncDisplayNameFromProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user?.profile?.nameCommitment) return;
  await bumpProfileVersion(userId, {
    displayCommitment: user.profile.nameCommitment,
  });
}

export async function getVerifiedIdentityProfileView(userId: string) {
  const profile = await ensureVerifiedIdentityProfile(userId);
  const portrait = profile.identityPortraitId
    ? await prisma.identityPortrait.findUnique({
        where: { id: profile.identityPortraitId },
      })
    : null;

  const latestPortrait = await prisma.identityPortrait.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return {
    trustId: profile.trustId,
    displayName: null as string | null,
    displayCommitment: profile.displayCommitment,
    identityStatus: profile.identityStatus,
    verificationLevel: profile.verificationLevel,
    verificationMethod: profile.verificationMethod,
    identityPortraitRef:
      portrait?.status === PORTRAIT_STATUS.VERIFIED ? portrait.id : null,
    portraitVersion: profile.portraitVersion,
    profileVersion: profile.profileVersion,
    status: profile.status,
    issuedAt: profile.issuedAt?.toISOString() ?? null,
    updatedAt: profile.updatedAt.toISOString(),
    revokedAt: profile.revokedAt?.toISOString() ?? null,
    latestPortraitStatus: latestPortrait?.status ?? PORTRAIT_STATUS.NONE,
    isVerifiedIdentity:
      profile.identityStatus === IDENTITY_STATUS.VERIFIED &&
      profile.status === "active",
    hasVerifiedIdentityPortrait:
      portrait?.status === PORTRAIT_STATUS.VERIFIED &&
      profile.identityStatus === IDENTITY_STATUS.VERIFIED,
    disclaimer:
      "A user-uploaded photograph is not a verified identity portrait until TrustID verification succeeds. Name, email, phone, and photos alone do not prove identity. TrustID stores commitments only — not plaintext PII.",
  };
}
