import { AUDIT_EVENTS } from "@trustid/shared";
import { createHash } from "node:crypto";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { hashSecret, randomToken } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import {
  clearSessionPresentation,
  sealSessionPresentation,
  type PresentationPayload,
} from "./presentation.js";

export async function createSession(input: {
  userId: string;
  deviceId?: string | null;
  applicationId?: string | null;
  kind?: string;
  expiresAt?: Date;
  ip?: string | null;
  userAgent?: string | null;
  presentation?: PresentationPayload | null;
}) {
  const token = randomToken(32);
  const expiresAt =
    input.expiresAt ??
    new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      applicationId: input.applicationId ?? null,
      kind: input.kind ?? "standard",
      tokenHash: hashSecret(token),
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
  if (input.presentation) {
    await sealSessionPresentation(session.id, input.presentation, expiresAt);
  }
  await recordAudit({
    type: AUDIT_EVENTS.SESSION_CREATED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      sessionId: session.id,
      deviceId: input.deviceId,
      kind: input.kind ?? "standard",
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return { session, token };
}

export async function resolveSession(token: string) {
  const tokenHash = hashSecret(token);
  const legacyHash = createHash("sha256").update(token).digest("hex");
  const session =
    (await prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: { include: { profile: true } },
        device: true,
      },
    })) ??
    (await prisma.session.findUnique({
      where: { tokenHash: legacyHash },
      include: {
        user: { include: { profile: true } },
        device: true,
      },
    }));
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  if (
    session.device?.trustLevel === "temporary" &&
    session.device.expiresAt &&
    session.device.expiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  if (session.device?.status === "revoked") return null;
  await prisma.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });
  if (session.deviceId) {
    await prisma.device.update({
      where: { id: session.deviceId },
      data: { lastActiveAt: new Date() },
    });
  }
  return session;
}

export async function revokeSession(
  sessionId: string,
  userId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session || session.revokedAt) return false;
  await clearSessionPresentation(sessionId);
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
  await recordAudit({
    type: AUDIT_EVENTS.SESSION_REVOKED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { sessionId },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
  return true;
}

export async function revokeAllSessions(
  userId: string,
  exceptSessionId?: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
  });
  for (const s of sessions) {
    await clearSessionPresentation(s.id);
  }
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  for (const s of sessions) {
    await recordAudit({
      type: AUDIT_EVENTS.SESSION_REVOKED,
      userId,
      actorType: "user",
      actorId: userId,
      metadata: { sessionId: s.id, global: true },
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });
  }
  return sessions.length;
}

export async function listSessions(userId: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { device: true, application: true },
    orderBy: { lastSeenAt: "desc" },
  });
  return sessions.map((s) => ({
    id: s.id,
    deviceId: s.deviceId,
    deviceName: s.device?.name ?? null,
    applicationId: s.applicationId,
    applicationName: s.application?.name ?? "TrustID",
    kind: s.kind,
    ip: s.ip,
    userAgent: s.userAgent,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  }));
}
