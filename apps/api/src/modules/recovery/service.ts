import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";
import {
  getRecoveryArchitectureNotes as legacyNotes,
  listRecoveryProviders,
  registerRecoveryProvider,
  type RecoveryProvider,
} from "./types.js";

function hashInvite(code: string): string {
  return createHash("sha256").update(`guardian-invite:${code}`).digest("hex");
}

function randomInviteCode(): string {
  return randomBytes(16).toString("base64url");
}

const createCircleSchema = z.object({
  threshold: z.number().int().min(2).max(16),
  shareCount: z.number().int().min(2).max(32),
  secretCommitment: z.string().min(16),
  shares: z
    .array(
      z.object({
        shareIndex: z.number().int().min(1).max(255),
        /** Client-sealed ciphertext of the Shamir share (server-blind). */
        shareCiphertext: z.string().min(8),
        guardianLabel: z.string().min(1).max(80),
        guardianTrustId: z.string().optional(),
      }),
    )
    .min(2),
});

export async function createGuardianCircle(input: {
  userId: string;
  body: unknown;
}) {
  const body = createCircleSchema.parse(input.body);
  if (body.shareCount !== body.shares.length) {
    throw Object.assign(new Error("shareCount must match shares length"), {
      statusCode: 400,
    });
  }
  if (body.threshold > body.shareCount) {
    throw Object.assign(new Error("threshold cannot exceed shareCount"), {
      statusCode: 400,
    });
  }

  const existing = await prisma.recoveryGuardianCircle.findFirst({
    where: { userId: input.userId, status: "active" },
  });
  if (existing) {
    throw Object.assign(new Error("Active guardian circle already exists ù revoke first"), {
      statusCode: 409,
    });
  }

  const inviteCodes: Array<{ shareIndex: number; inviteCode: string }> = [];

  const circle = await prisma.$transaction(async (tx) => {
    const c = await tx.recoveryGuardianCircle.create({
      data: {
        userId: input.userId,
        threshold: body.threshold,
        shareCount: body.shareCount,
        secretCommitment: body.secretCommitment,
        status: "active",
      },
    });

    for (const share of body.shares) {
      const inviteCode = randomInviteCode();
      inviteCodes.push({ shareIndex: share.shareIndex, inviteCode });
      await tx.recoveryGuardianShare.create({
        data: {
          circleId: c.id,
          shareIndex: share.shareIndex,
          shareCiphertext: share.shareCiphertext,
          guardianLabel: share.guardianLabel,
          guardianTrustId: share.guardianTrustId ?? null,
          inviteCodeHash: hashInvite(inviteCode),
          status: "distributed",
        },
      });
    }

    await tx.recoveryMethod.create({
      data: {
        userId: input.userId,
        type: "shamir_guardians",
        status: "active",
      },
    });

    return c;
  });

  await recordAudit({
    type: AUDIT_EVENTS.RECOVERY_GUARDIAN_CIRCLE_CREATED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      circleId: circle.id,
      threshold: body.threshold,
      shareCount: body.shareCount,
    },
  });

  // Invite codes returned once ù never stored plaintext.
  return {
    circleId: circle.id,
    threshold: circle.threshold,
    shareCount: circle.shareCount,
    inviteCodes,
  };
}

export async function getGuardianCircleStatus(userId: string) {
  const circle = await prisma.recoveryGuardianCircle.findFirst({
    where: { userId, status: { in: ["active", "recovering"] } },
    include: {
      shares: {
        select: {
          id: true,
          shareIndex: true,
          guardianLabel: true,
          guardianTrustId: true,
          status: true,
          claimedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!circle) {
    return {
      status: "none" as const,
      providers: listRecoveryProviders(),
      architecture: getRecoveryArchitectureNotes(),
    };
  }

  return {
    status: circle.status,
    circleId: circle.id,
    threshold: circle.threshold,
    shareCount: circle.shareCount,
    secretCommitment: circle.secretCommitment,
    shares: circle.shares,
    providers: listRecoveryProviders(),
  };
}

export async function revokeGuardianCircle(userId: string) {
  const circle = await prisma.recoveryGuardianCircle.findFirst({
    where: { userId, status: { in: ["active", "recovering"] } },
  });
  if (!circle) {
    throw Object.assign(new Error("No active circle"), { statusCode: 404 });
  }
  await prisma.recoveryGuardianCircle.update({
    where: { id: circle.id },
    data: { status: "revoked", revokedAt: new Date() },
  });
  return { ok: true };
}

/** Guardian claims their sealed share with invite code (no account PII). */
export async function claimGuardianShare(input: { inviteCode: string }) {
  const hash = hashInvite(input.inviteCode.trim());
  const share = await prisma.recoveryGuardianShare.findFirst({
    where: { inviteCodeHash: hash },
    include: { circle: true },
  });
  if (!share || share.circle.status === "revoked") {
    throw Object.assign(new Error("Invalid invite"), { statusCode: 404 });
  }

  await prisma.recoveryGuardianShare.update({
    where: { id: share.id },
    data: { status: "claimed", claimedAt: new Date() },
  });

  await recordAudit({
    type: AUDIT_EVENTS.RECOVERY_GUARDIAN_SHARE_CLAIMED,
    userId: share.circle.userId,
    actorType: "system",
    actorId: null,
    metadata: {
      circleId: share.circleId,
      shareIndex: share.shareIndex,
    },
  });

  return {
    circleId: share.circleId,
    shareIndex: share.shareIndex,
    guardianLabel: share.guardianLabel,
    /** Sealed ciphertext ù only the intended guardian client can open if client-sealed. */
    shareCiphertext: share.shareCiphertext,
    secretCommitment: share.circle.secretCommitment,
    threshold: share.circle.threshold,
  };
}

export async function startRecoverySession(userId: string) {
  const circle = await prisma.recoveryGuardianCircle.findFirst({
    where: { userId, status: "active" },
  });
  if (!circle) {
    throw Object.assign(new Error("No active guardian circle"), { statusCode: 404 });
  }

  await prisma.recoveryGuardianCircle.update({
    where: { id: circle.id },
    data: { status: "recovering" },
  });

  const session = await prisma.recoverySession.create({
    data: {
      userId,
      circleId: circle.id,
      status: "collecting",
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.RECOVERY_STARTED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { sessionId: session.id, circleId: circle.id },
  });

  return {
    sessionId: session.id,
    circleId: circle.id,
    threshold: circle.threshold,
    expiresAt: session.expiresAt,
  };
}

/**
 * Record that a share index was contributed client-side.
 * Actual Shamir combine happens on the client ù server only tracks threshold progress.
 */
export async function submitRecoveryShareIndex(input: {
  userId: string;
  sessionId: string;
  shareIndex: number;
  /** Optional commitment after client verifies share authenticity */
  shareCommitment?: string;
}) {
  const session = await prisma.recoverySession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    include: { circle: true },
  });
  if (!session || session.status === "expired" || session.status === "completed") {
    throw Object.assign(new Error("Invalid recovery session"), { statusCode: 400 });
  }
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.recoverySession.update({
      where: { id: session.id },
      data: { status: "expired" },
    });
    throw Object.assign(new Error("Recovery session expired"), { statusCode: 410 });
  }

  let indexes: number[] = [];
  try {
    indexes = JSON.parse(session.collectedShareIndexesJson) as number[];
  } catch {
    indexes = [];
  }
  if (!indexes.includes(input.shareIndex)) {
    indexes.push(input.shareIndex);
  }

  const thresholdMet = indexes.length >= session.circle.threshold;
  const updated = await prisma.recoverySession.update({
    where: { id: session.id },
    data: {
      collectedShareIndexesJson: JSON.stringify(indexes),
      status: thresholdMet ? "completed" : "collecting",
      completedAt: thresholdMet ? new Date() : null,
      reconstructionCommitment: input.shareCommitment ?? session.reconstructionCommitment,
    },
  });

  if (thresholdMet) {
    await prisma.recoveryGuardianCircle.update({
      where: { id: session.circleId },
      data: { status: "active" },
    });
    await recordAudit({
      type: AUDIT_EVENTS.RECOVERY_GUARDIAN_THRESHOLD_MET,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: { sessionId: session.id, indexes },
    });
    await recordAudit({
      type: AUDIT_EVENTS.RECOVERY_COMPLETED,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: { sessionId: session.id },
    });
  }

  return {
    sessionId: updated.id,
    collectedCount: indexes.length,
    threshold: session.circle.threshold,
    thresholdMet,
    status: updated.status,
  };
}

const shamirProvider: RecoveryProvider = {
  kind: "shamir_guardians",
  enabled: true,
};

registerRecoveryProvider(shamirProvider);

export function getRecoveryArchitectureNotes() {
  return {
    ...legacyNotes(),
    status: "partial",
    protocols: {
      guardians: "Shamir SSS GF(256), threshold t-of-n; server stores sealed shares + commitment only",
      deviceSync: "X3DH-inspired blind relay; server never sees session keys or plaintext",
      attestation: "FIDO MDS-inspired AAGUID catalog with soft/strict policy",
    },
    extensionPoints: [
      "government_identity",
      "recovery_codes",
      "trusted_contact",
      "shamir_guardians",
      "manual_review",
    ],
    note: "Guardian recovery never bypasses primary-device controls without a separate high-assurance enrollment of a new passkey after client-side secret reconstruction.",
  };
}
