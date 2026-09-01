import {
  AUDIT_EVENTS,
  MASTER_AUTH_CHALLENGE_STATUS,
  TRUST_ID_ACCESS_LEVELS,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { hashMasterActionPayload, hashSecret, randomToken } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { createSecurityNotification } from "../notifications/service.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function issueMasterChallenge(input: {
  userId: string;
  action: string;
  payload?: Record<string, unknown>;
  requesterFingerprint?: string;
  ip?: string;
  userAgent?: string;
}) {
  const payloadHash = hashMasterActionPayload(input.action, input.payload ?? {});
  const challengeId = randomToken(16);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  const row = await prisma.masterAuthChallenge.create({
    data: {
      challengeId,
      userId: input.userId,
      action: input.action,
      payloadHash,
      requesterFingerprint: input.requesterFingerprint ?? null,
      status: MASTER_AUTH_CHALLENGE_STATUS.PENDING,
      expiresAt,
    },
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "master_auth_challenge",
    title: "Approve sensitive action",
    body: `A ${input.action.replace(/_/g, " ")} was requested on another device. Approve on your Master Device.`,
    payload: {
      challengeId: row.challengeId,
      action: input.action,
      expiresAt: expiresAt.toISOString(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.MASTER_AUTH_CHALLENGE_ISSUED,
    userId: input.userId,
    actorType: "system",
    metadata: {
      challengeId: row.challengeId,
      action: input.action,
      requesterFingerprint: input.requesterFingerprint,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    challengeId: row.challengeId,
    action: row.action,
    payloadHash: row.payloadHash,
    expiresAt: expiresAt.toISOString(),
    status: row.status,
  };
}

async function expireIfNeeded(row: {
  challengeId: string;
  userId: string;
  status: string;
  expiresAt: Date;
}) {
  if (row.status !== MASTER_AUTH_CHALLENGE_STATUS.PENDING) return false;
  if (row.expiresAt.getTime() >= Date.now()) return false;
  await prisma.masterAuthChallenge.update({
    where: { challengeId: row.challengeId },
    data: { status: MASTER_AUTH_CHALLENGE_STATUS.EXPIRED },
  });
  await recordAudit({
    type: AUDIT_EVENTS.MASTER_AUTH_CHALLENGE_EXPIRED,
    userId: row.userId,
    actorType: "system",
    metadata: { challengeId: row.challengeId },
  });
  return true;
}

export async function approveMasterChallenge(input: {
  userId: string;
  challengeId: string;
  deviceFingerprint: string;
  signature: string;
  ip?: string;
  userAgent?: string;
}) {
  const row = await prisma.masterAuthChallenge.findFirst({
    where: { challengeId: input.challengeId, userId: input.userId },
  });
  if (!row) {
    throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
  }
  if (await expireIfNeeded(row)) {
    throw Object.assign(new Error("Challenge expired"), { statusCode: 400 });
  }
  if (row.status !== MASTER_AUTH_CHALLENGE_STATUS.PENDING) {
    throw Object.assign(new Error("Challenge already resolved"), { statusCode: 409 });
  }

  const sigHash = hashSecret(input.signature);
  const updated = await prisma.masterAuthChallenge.update({
    where: { challengeId: row.challengeId },
    data: {
      status: MASTER_AUTH_CHALLENGE_STATUS.APPROVED,
      approvalSignatureHash: sigHash,
      approvedAt: new Date(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.MASTER_AUTH_CHALLENGE_APPROVED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      challengeId: row.challengeId,
      action: row.action,
      deviceFingerprint: input.deviceFingerprint,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    challengeId: updated.challengeId,
    status: updated.status,
    action: updated.action,
    accessLevel: TRUST_ID_ACCESS_LEVELS.MASTER,
  };
}

export async function getMasterChallenge(challengeId: string) {
  const row = await prisma.masterAuthChallenge.findUnique({
    where: { challengeId },
  });
  if (!row) return null;
  if (await expireIfNeeded(row)) {
    return prisma.masterAuthChallenge.findUnique({ where: { challengeId } });
  }
  return row;
}
