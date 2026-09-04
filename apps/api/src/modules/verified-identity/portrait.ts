import { createHash, randomBytes } from "node:crypto";
import {
  AUDIT_EVENTS,
  IDENTITY_STATUS,
  IDENTITY_VERIFICATION_STATUS,
  PORTRAIT_STATUS,
  VERIFICATION_LEVELS,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";
import {
  allowedPortraitMime,
  createMediaAccessToken,
  storePrivateBytes,
} from "./media.js";
import { ensureVerifiedIdentityProfile, bumpProfileVersion } from "./profile.js";

const MAX_PORTRAIT_BYTES = 2 * 1024 * 1024;

function httpErr(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

export async function uploadIdentityPortrait(input: {
  userId: string;
  bytes: Buffer;
  mimeType: string;
  ip?: string;
  userAgent?: string;
}) {
  if (!allowedPortraitMime(input.mimeType)) {
    throw httpErr("Unsupported image type", 400, "invalid_request");
  }
  if (input.bytes.byteLength > MAX_PORTRAIT_BYTES) {
    throw httpErr("Portrait exceeds 2MB limit", 400, "invalid_request");
  }
  if (input.bytes.byteLength < 64) {
    throw httpErr("Portrait too small", 400, "invalid_request");
  }

  const profile = await ensureVerifiedIdentityProfile(input.userId);
  if (profile.status === "revoked" || profile.identityStatus === IDENTITY_STATUS.REVOKED) {
    throw httpErr("Identity revoked", 403, "identity_revoked");
  }

  const stored = await storePrivateBytes({
    userId: input.userId,
    trustId: profile.trustId,
    purpose: "identity_portrait",
    mimeType: input.mimeType,
    bytes: input.bytes,
  });

  const media = await prisma.identityMediaObject.create({
    data: {
      userId: input.userId,
      storageKey: stored.storageKey,
      mimeType: input.mimeType,
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
      purpose: "identity_portrait",
    },
  });

  // Same hash on another account ≠ same person. Record collision metadata only.
  const otherWithSameHash = await prisma.identityPortrait.findFirst({
    where: {
      contentHash: stored.contentHash,
      userId: { not: input.userId },
      status: { in: [PORTRAIT_STATUS.VERIFIED, PORTRAIT_STATUS.PENDING_VERIFICATION] },
    },
    select: { id: true, userId: true },
  });

  const portrait = await prisma.identityPortrait.create({
    data: {
      userId: input.userId,
      mediaObjectId: media.id,
      status: PORTRAIT_STATUS.USER_UPLOADED,
      version: 1,
      contentHash: stored.contentHash,
      mimeType: input.mimeType,
      byteSize: stored.byteSize,
    },
  });

  await bumpProfileVersion(input.userId, {
    identityStatus: IDENTITY_STATUS.UNVERIFIED,
  });

  await recordAudit({
    type: AUDIT_EVENTS.PORTRAIT_UPLOADED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      portraitId: portrait.id,
      contentHashPrefix: stored.contentHash.slice(0, 12),
      hashCollisionWithOtherUser: Boolean(otherWithSameHash),
      // Never log other user's trustId/PII
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    portrait: serializePortrait(portrait, { ownerView: true }),
    note: "Uploaded photograph is NOT a verified identity portrait until TrustID verification succeeds.",
    hashCollisionDetected: Boolean(otherWithSameHash),
    hashCollisionNote: otherWithSameHash
      ? "Another account has a photograph with the same content hash. Accounts are NOT merged. This does not verify identity."
      : null,
  };
}

export async function getPortraitForOwner(userId: string, portraitId?: string) {
  const portrait = portraitId
    ? await prisma.identityPortrait.findFirst({
        where: { id: portraitId, userId },
        include: { mediaObject: true },
      })
    : await prisma.identityPortrait.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { mediaObject: true },
      });
  if (!portrait) return null;

  const access = createMediaAccessToken({
    mediaId: portrait.mediaObjectId,
    userId,
    audience: userId,
    ttlSeconds: 120,
  });

  return {
    ...serializePortrait(portrait, { ownerView: true }),
    mediaAccess: {
      path: `/identity/media/${portrait.mediaObjectId}`,
      token: access.token,
      expiresAt: access.expiresAt.toISOString(),
    },
    isVerifiedIdentityPortrait: portrait.status === PORTRAIT_STATUS.VERIFIED,
  };
}

/** Apps may only retrieve VERIFIED portraits (via assertion/scoped token). */
export async function getVerifiedPortraitForAudience(input: {
  subjectUserId: string;
  audience: string;
  requireVerified?: boolean;
}) {
  const profile = await prisma.verifiedIdentityProfile.findUnique({
    where: { userId: input.subjectUserId },
  });
  if (!profile?.identityPortraitId) {
    throw httpErr("Portrait not verified", 404, "portrait_not_verified");
  }
  if (
    profile.identityStatus !== IDENTITY_STATUS.VERIFIED ||
    profile.status !== "active"
  ) {
    throw httpErr("Identity revoked", 403, "identity_revoked");
  }

  const portrait = await prisma.identityPortrait.findFirst({
    where: {
      id: profile.identityPortraitId,
      userId: input.subjectUserId,
      status: PORTRAIT_STATUS.VERIFIED,
    },
  });
  if (!portrait) {
    throw httpErr("Portrait not verified", 404, "portrait_not_verified");
  }

  const access = createMediaAccessToken({
    mediaId: portrait.mediaObjectId,
    userId: input.subjectUserId,
    audience: input.audience,
    ttlSeconds: 90,
  });

  return {
    portraitRef: portrait.id,
    portraitVersion: portrait.version,
    profileVersion: profile.profileVersion,
    status: PORTRAIT_STATUS.VERIFIED,
    mediaAccess: {
      path: `/identity/media/${portrait.mediaObjectId}`,
      token: access.token,
      expiresAt: access.expiresAt.toISOString(),
    },
  };
}

export async function markPortraitPending(userId: string, portraitId: string) {
  const portrait = await prisma.identityPortrait.findFirst({
    where: { id: portraitId, userId },
  });
  if (!portrait) throw httpErr("Portrait not found", 404, "not_found");
  if (
    portrait.status !== PORTRAIT_STATUS.USER_UPLOADED &&
    portrait.status !== PORTRAIT_STATUS.REJECTED
  ) {
    throw httpErr("Portrait not eligible for verification", 409, "conflict");
  }
  return prisma.identityPortrait.update({
    where: { id: portrait.id },
    data: { status: PORTRAIT_STATUS.PENDING_VERIFICATION },
  });
}

export async function issueVerifiedPortrait(input: {
  userId: string;
  portraitId: string;
  verificationMethod: string;
  verificationLevel: string;
  isMock: boolean;
  ip?: string;
  userAgent?: string;
}) {
  const portrait = await prisma.identityPortrait.findFirst({
    where: { id: input.portraitId, userId: input.userId },
  });
  if (!portrait) throw httpErr("Portrait not found", 404, "not_found");

  // Revoke previous verified portraits for this user
  const previous = await prisma.identityPortrait.findMany({
    where: {
      userId: input.userId,
      status: PORTRAIT_STATUS.VERIFIED,
      id: { not: portrait.id },
    },
  });
  for (const p of previous) {
    await prisma.identityPortrait.update({
      where: { id: p.id },
      data: { status: PORTRAIT_STATUS.REVOKED, revokedAt: new Date() },
    });
    await recordAudit({
      type: AUDIT_EVENTS.PORTRAIT_REVOKED,
      userId: input.userId,
      actorType: "system",
      actorId: input.userId,
      metadata: { portraitId: p.id, reason: "superseded" },
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  const nextVersion =
    (await prisma.identityPortrait.aggregate({
      where: { userId: input.userId },
      _max: { version: true },
    }))._max.version ?? 0;

  const verified = await prisma.identityPortrait.update({
    where: { id: portrait.id },
    data: {
      status: PORTRAIT_STATUS.VERIFIED,
      version: nextVersion + 1,
      verifiedAt: new Date(),
      revokedAt: null,
    },
  });

  const profile = await ensureVerifiedIdentityProfile(input.userId);
  await prisma.verifiedIdentityProfile.update({
    where: { userId: input.userId },
    data: {
      identityStatus: IDENTITY_STATUS.VERIFIED,
      verificationLevel: input.isMock
        ? VERIFICATION_LEVELS.MOCK
        : input.verificationLevel,
      verificationMethod: input.verificationMethod,
      identityPortraitId: verified.id,
      portraitVersion: verified.version,
      profileVersion: profile.profileVersion + 1,
      status: "active",
      issuedAt: new Date(),
      revokedAt: null,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.PORTRAIT_VERIFIED,
    userId: input.userId,
    actorType: "system",
    actorId: input.userId,
    metadata: {
      portraitId: verified.id,
      portraitVersion: verified.version,
      isMock: input.isMock,
      method: input.verificationMethod,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.PORTRAIT_CHANGED,
    userId: input.userId,
    actorType: "system",
    actorId: input.userId,
    metadata: { portraitId: verified.id, portraitVersion: verified.version },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return verified;
}

export async function rejectPortrait(input: {
  userId: string;
  portraitId: string;
  reason: string;
  ip?: string;
  userAgent?: string;
}) {
  const portrait = await prisma.identityPortrait.findFirst({
    where: { id: input.portraitId, userId: input.userId },
  });
  if (!portrait) throw httpErr("Portrait not found", 404, "not_found");
  const updated = await prisma.identityPortrait.update({
    where: { id: portrait.id },
    data: {
      status: PORTRAIT_STATUS.REJECTED,
      rejectionReason: input.reason,
    },
  });
  await bumpProfileVersion(input.userId, {
    identityStatus: IDENTITY_STATUS.UNVERIFIED,
  });
  await recordAudit({
    type: AUDIT_EVENTS.PORTRAIT_REJECTED,
    userId: input.userId,
    actorType: "system",
    actorId: input.userId,
    metadata: { portraitId: portrait.id, reason: input.reason },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return updated;
}

export async function revokeVerifiedPortrait(input: {
  userId: string;
  reason: string;
  ip?: string;
  userAgent?: string;
}) {
  const profile = await prisma.verifiedIdentityProfile.findUnique({
    where: { userId: input.userId },
  });
  if (!profile?.identityPortraitId) {
    throw httpErr("Portrait not verified", 404, "portrait_not_verified");
  }
  await prisma.identityPortrait.update({
    where: { id: profile.identityPortraitId },
    data: { status: PORTRAIT_STATUS.REVOKED, revokedAt: new Date() },
  });
  await prisma.verifiedIdentityProfile.update({
    where: { userId: input.userId },
    data: {
      identityStatus: IDENTITY_STATUS.REVOKED,
      identityPortraitId: null,
      portraitVersion: profile.portraitVersion,
      profileVersion: profile.profileVersion + 1,
      status: "revoked",
      revokedAt: new Date(),
    },
  });
  await recordAudit({
    type: AUDIT_EVENTS.PORTRAIT_REVOKED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { reason: input.reason },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_VERIFICATION_REVOKED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { reason: input.reason },
    ip: input.ip,
    userAgent: input.userAgent,
  });
}

function serializePortrait(
  portrait: {
    id: string;
    status: string;
    version: number;
    mimeType: string;
    byteSize: number;
    verifiedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    rejectionReason?: string | null;
  },
  opts: { ownerView: boolean },
) {
  return {
    id: portrait.id,
    status: portrait.status,
    version: portrait.version,
    mimeType: portrait.mimeType,
    byteSize: portrait.byteSize,
    verifiedAt: portrait.verifiedAt?.toISOString() ?? null,
    revokedAt: portrait.revokedAt?.toISOString() ?? null,
    createdAt: portrait.createdAt.toISOString(),
    isVerifiedIdentityPortrait: portrait.status === PORTRAIT_STATUS.VERIFIED,
    rejectionReason: opts.ownerView ? portrait.rejectionReason ?? null : undefined,
  };
}

export function decodeDataUrlImage(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(dataUrl.replace(/\s/g, ""));
  if (!m) {
    throw httpErr("Expected data URL image/jpeg|png|webp", 400, "invalid_request");
  }
  return { mimeType: m[1]!.toLowerCase(), bytes: Buffer.from(m[2]!, "base64") };
}

export function sha256Hex(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

export function randomRef() {
  return randomBytes(12).toString("hex");
}

export { IDENTITY_VERIFICATION_STATUS };
