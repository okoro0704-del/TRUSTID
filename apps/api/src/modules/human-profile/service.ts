/**
 * TrustID Human Profile V1: self-declared names and a profile picture bound to
 * the immutable TrustID subject, plus optional identity document submission.
 *
 * - The subject always comes from the authenticated session or access token.
 * - Names are sealed at rest and are never keys, biometric identifiers or
 *   proof of legal identity.
 * - The avatar is private media (purpose profile_avatar); it is never an
 *   IdentityPortrait and never biometric enrollment evidence.
 * - Documents are private media (purpose identity_document), never served by
 *   profile, addressing or OIDC APIs, and stay UNVERIFIED (see verification.ts).
 */
import { AUDIT_EVENTS } from "@trustid/shared";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { openJson, sealJson } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import {
  createMediaAccessToken,
  deletePrivateBytesStrict,
  storePrivateBytes,
} from "../verified-identity/media.js";
import { decodeImageDataUrl, sanitizeImage } from "./image-sanitizer.js";
import { DOCUMENT_VERIFICATION_STATUS, VERIFICATION_PROVIDER_NONE } from "./verification.js";

export const AVATAR_PURPOSE = "profile_avatar";
export const DOCUMENT_PURPOSE = "identity_document";
export const DOCUMENT_CONSENT_VERSION = "identity-document-consent-v1";
export const DOCUMENT_TYPES = [
  "passport",
  "national_id",
  "drivers_licence",
  "voters_card",
  "residence_permit",
  "other",
] as const;

/** Names are self-declared; this is the only classification V1 can make. */
export const NAME_VERIFICATION_CLASSIFICATION = "SELF_DECLARED";

const AVATAR_LIMITS = { maxBytes: 2 * 1024 * 1024, minDimension: 64, maxDimension: 4096 };
const DOCUMENT_LIMITS = { maxBytes: 5 * 1024 * 1024, minDimension: 320, maxDimension: 8192 };
const AVATAR_LINK_TTL_SECONDS = 600;

type Names = {
  givenName: string;
  familyName: string;
  preferredName: string;
  displayName: string;
};

type Actor = { userId: string; ip?: string; userAgent?: string };

function httpErr(code: string, statusCode: number, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Letters, marks, spaces and common name punctuation; no control or markup characters.
const nameText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .max(max)
        .regex(/^[\p{L}\p{M}\p{N} .'’-]*$/u, "Names may contain letters, spaces, apostrophes, hyphens and periods"),
    );

export const profileInputSchema = z
  .object({
    givenName: nameText(100).pipe(z.string().min(1, "Given name is required")),
    familyName: nameText(100).optional(),
    preferredName: nameText(60).optional(),
    displayName: nameText(120).optional(),
    /** Optimistic concurrency: the profileVersion the client edited. */
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

async function subjectFor(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { trustId: true, status: true } });
  if (!user) throw httpErr("unauthorized", 401);
  if (user.status === "revoked") throw httpErr("identity_revoked", 403);
  return user.trustId;
}

function openNames(sealed: string): Names {
  return openJson<Names>(sealed);
}

function effectiveDisplayName(n: Names): string {
  return n.displayName || [n.givenName, n.familyName].filter(Boolean).join(" ");
}

function addressName(n: Names): string {
  return n.preferredName || effectiveDisplayName(n);
}

function avatarAccess(mediaId: string, userId: string, audience: string, ttlSeconds?: number) {
  const access = createMediaAccessToken({ mediaId, userId, audience, ttlSeconds });
  return {
    path: `/identity/media/${mediaId}`,
    token: access.token,
    expiresAt: access.expiresAt.toISOString(),
  };
}

/** Absolute, short-lived, audience-bound link for relying parties (OIDC picture, Digi AI). */
function avatarUrlFor(mediaId: string, userId: string, audience: string) {
  const access = avatarAccess(mediaId, userId, audience, AVATAR_LINK_TTL_SECONDS);
  return {
    url: `${config.oidcIssuer}${access.path}?token=${encodeURIComponent(access.token)}`,
    expiresAt: access.expiresAt,
  };
}

function serializeDocument(d: {
  id: string;
  documentType: string;
  submittedAt: Date;
  verificationStatus: string;
  verificationProvider: string;
  consentVersion: string;
  consentedAt: Date;
}) {
  return {
    id: d.id,
    documentType: d.documentType,
    submittedAt: d.submittedAt.toISOString(),
    verificationStatus: d.verificationStatus,
    verificationProvider: d.verificationProvider,
    consentVersion: d.consentVersion,
    consentedAt: d.consentedAt.toISOString(),
  };
}

/** Owner view (first-party session only). Never includes document bytes or storage keys. */
export async function getOwnProfile(userId: string) {
  const subjectId = await subjectFor(userId);
  const [profile, documents] = await Promise.all([
    prisma.humanProfile.findUnique({ where: { userId } }),
    prisma.identityDocumentSubmission.findMany({
      where: { userId, deletedAt: null },
      orderBy: { submittedAt: "desc" },
    }),
  ]);
  const names = profile ? openNames(profile.namesSealed) : null;
  return {
    subjectId,
    completed: Boolean(names?.givenName),
    profile: profile && names
      ? {
          subjectId: profile.subjectId,
          givenName: names.givenName,
          familyName: names.familyName,
          preferredName: names.preferredName,
          displayName: effectiveDisplayName(names),
          avatarAssetId: profile.avatarMediaId,
          avatar: profile.avatarMediaId ? avatarAccess(profile.avatarMediaId, userId, userId) : null,
          profileVersion: profile.profileVersion,
          createdAt: profile.createdAt.toISOString(),
          updatedAt: profile.updatedAt.toISOString(),
        }
      : null,
    nameVerification: NAME_VERIFICATION_CLASSIFICATION,
    documents: documents.map(serializeDocument),
    note: "Names are self-declared. They are not verified legal identity.",
  };
}

export async function saveProfile(actor: Actor, raw: unknown) {
  const input = profileInputSchema.parse(raw);
  const subjectId = await subjectFor(actor.userId);
  const names: Names = {
    givenName: input.givenName,
    familyName: input.familyName ?? "",
    preferredName: input.preferredName ?? "",
    displayName: input.displayName ?? "",
  };
  const existing = await prisma.humanProfile.findUnique({ where: { userId: actor.userId } });
  if (existing) {
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.profileVersion) {
      throw httpErr("profile_version_conflict", 409, "The profile changed since it was loaded");
    }
    const updated = await prisma.humanProfile.updateMany({
      where: { userId: actor.userId, profileVersion: existing.profileVersion },
      data: { namesSealed: sealJson(names), profileVersion: { increment: 1 } },
    });
    if (updated.count !== 1) throw httpErr("profile_version_conflict", 409, "The profile changed since it was loaded");
  } else {
    if (input.expectedVersion !== undefined) {
      throw httpErr("profile_version_conflict", 409, "The profile changed since it was loaded");
    }
    await prisma.humanProfile.create({
      data: { userId: actor.userId, subjectId, namesSealed: sealJson(names) },
    });
  }
  await recordAudit({
    type: AUDIT_EVENTS.HUMAN_PROFILE_UPDATED,
    userId: actor.userId,
    actorType: "user",
    actorId: actor.userId,
    // Never log names.
    metadata: { created: !existing },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return getOwnProfile(actor.userId);
}

async function requireProfile(userId: string) {
  const profile = await prisma.humanProfile.findUnique({ where: { userId } });
  if (!profile) throw httpErr("profile_required", 409, "Save your name before adding a profile picture");
  return profile;
}

async function removeMedia(mediaId: string) {
  const media = await prisma.identityMediaObject.findUnique({ where: { id: mediaId } });
  if (!media) return;
  await deletePrivateBytesStrict(media.storageKey);
  await prisma.identityMediaObject.update({ where: { id: media.id }, data: { deletedAt: new Date() } });
}

export async function setAvatar(actor: Actor, imageDataUrl: string) {
  const profile = await requireProfile(actor.userId);
  const { declaredType, bytes } = decodeImageDataUrl(imageDataUrl);
  const image = sanitizeImage(bytes, declaredType, AVATAR_LIMITS);
  const stored = await storePrivateBytes({
    userId: actor.userId,
    trustId: profile.subjectId,
    purpose: AVATAR_PURPOSE,
    mimeType: image.mimeType,
    bytes: image.bytes,
    localOnly: true,
  });
  const media = await prisma.identityMediaObject.create({
    data: {
      userId: actor.userId,
      storageKey: stored.storageKey,
      mimeType: image.mimeType,
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
      purpose: AVATAR_PURPOSE,
    },
  });
  const replaced = profile.avatarMediaId;
  await prisma.humanProfile.update({
    where: { userId: actor.userId },
    data: { avatarMediaId: media.id, profileVersion: { increment: 1 } },
  });
  if (replaced) await removeMedia(replaced);
  await recordAudit({
    type: AUDIT_EVENTS.HUMAN_PROFILE_AVATAR_CHANGED,
    userId: actor.userId,
    actorType: "user",
    actorId: actor.userId,
    metadata: { replaced: Boolean(replaced), width: image.width, height: image.height },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return getOwnProfile(actor.userId);
}

export async function deleteAvatar(actor: Actor) {
  const profile = await prisma.humanProfile.findUnique({ where: { userId: actor.userId } });
  if (profile?.avatarMediaId) {
    await prisma.humanProfile.update({
      where: { userId: actor.userId },
      data: { avatarMediaId: null, profileVersion: { increment: 1 } },
    });
    await removeMedia(profile.avatarMediaId);
    await recordAudit({
      type: AUDIT_EVENTS.HUMAN_PROFILE_AVATAR_DELETED,
      userId: actor.userId,
      actorType: "user",
      actorId: actor.userId,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
  return getOwnProfile(actor.userId);
}

export const documentInputSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    imageDataUrl: z.string().min(32),
    consent: z
      .object({
        accepted: z.literal(true),
        version: z.literal(DOCUMENT_CONSENT_VERSION),
      })
      .strict(),
  })
  .strict();

export async function submitIdentityDocument(actor: Actor, raw: unknown) {
  const input = documentInputSchema.parse(raw);
  const subjectId = await subjectFor(actor.userId);
  const { declaredType, bytes } = decodeImageDataUrl(input.imageDataUrl);
  const image = sanitizeImage(bytes, declaredType, DOCUMENT_LIMITS);
  const stored = await storePrivateBytes({
    userId: actor.userId,
    trustId: subjectId,
    purpose: DOCUMENT_PURPOSE,
    mimeType: image.mimeType,
    bytes: image.bytes,
    localOnly: true,
  });
  const submission = await prisma.$transaction(async (tx) => {
    const media = await tx.identityMediaObject.create({
      data: {
        userId: actor.userId,
        storageKey: stored.storageKey,
        mimeType: image.mimeType,
        byteSize: stored.byteSize,
        contentHash: stored.contentHash,
        purpose: DOCUMENT_PURPOSE,
      },
    });
    return tx.identityDocumentSubmission.create({
      data: {
        userId: actor.userId,
        documentType: input.documentType,
        mediaObjectId: media.id,
        consentVersion: input.consent.version,
        consentedAt: new Date(),
        verificationStatus: DOCUMENT_VERIFICATION_STATUS.UNVERIFIED,
        verificationProvider: VERIFICATION_PROVIDER_NONE,
      },
    });
  });
  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_DOCUMENT_SUBMITTED,
    userId: actor.userId,
    actorType: "user",
    actorId: actor.userId,
    metadata: { submissionId: submission.id, documentType: input.documentType, consentVersion: input.consent.version },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return {
    document: serializeDocument(submission),
    note: "Submitted for future verification. It has not been checked, and your identity is not verified.",
  };
}

/** Deletes the stored document bytes and detaches them; cross-user ids are not found. */
export async function deleteIdentityDocument(actor: Actor, submissionId: string) {
  const submission = await prisma.identityDocumentSubmission.findFirst({
    where: { id: submissionId, userId: actor.userId, deletedAt: null },
  });
  if (!submission) throw httpErr("not_found", 404, "Document not found");
  // Remove the bytes first: a failed delete must never leave a "deleted" record behind.
  if (submission.mediaObjectId) await removeMedia(submission.mediaObjectId);
  await prisma.identityDocumentSubmission.update({
    where: { id: submission.id },
    data: { deletedAt: new Date(), mediaObjectId: null },
  });
  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_DOCUMENT_DELETED,
    userId: actor.userId,
    actorType: "user",
    actorId: actor.userId,
    metadata: { submissionId: submission.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { deleted: true };
}

/**
 * Minimal addressing profile for Digi AI and other consented clients. The
 * subject is the authenticated user; there is no way to name another subject.
 */
export async function getAddressingProfile(userId: string, audience: string) {
  const subjectId = await subjectFor(userId);
  const profile = await prisma.humanProfile.findUnique({ where: { userId } });
  const names = profile ? openNames(profile.namesSealed) : null;
  return {
    sub: subjectId,
    name: names ? addressName(names) : null,
    avatar: profile?.avatarMediaId ? avatarUrlFor(profile.avatarMediaId, userId, audience) : null,
    verification: NAME_VERIFICATION_CLASSIFICATION,
    profileVersion: profile?.profileVersion ?? 0,
  };
}

/** Standard OIDC profile claims for userinfo; only called when `profile` was granted. */
export async function getOidcProfileClaims(userId: string, audience: string) {
  const profile = await prisma.humanProfile.findUnique({ where: { userId } });
  if (!profile) return {};
  const names = openNames(profile.namesSealed);
  const claims: Record<string, unknown> = {
    name: effectiveDisplayName(names),
    given_name: names.givenName,
    updated_at: Math.floor(profile.updatedAt.getTime() / 1000),
  };
  if (names.familyName) claims.family_name = names.familyName;
  if (names.preferredName) claims.preferred_username = names.preferredName;
  if (profile.avatarMediaId) claims.picture = avatarUrlFor(profile.avatarMediaId, userId, audience).url;
  return claims;
}
