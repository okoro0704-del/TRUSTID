import { prisma } from "../../db/client.js";
import { getElfComClient } from "../baas/registry.js";

/**
 * In-app security notifications — prefer ElfCom inbox; local DB is legacy fallback only.
 */
export async function createSecurityNotification(input: {
  userId: string;
  type: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  ownerTrustId?: string;
}) {
  const elfcom = getElfComClient();
  if (elfcom.bound && input.ownerTrustId) {
    // Best-effort remote create when ElfCom exposes inbox write (pushConsent carries the alert).
    await elfcom.pushConsent({
      correlationId:
        typeof input.payload?.correlationId === "string"
          ? input.payload.correlationId
          : crypto.randomUUID(),
      requestId:
        typeof input.payload?.requestId === "string"
          ? input.payload.requestId
          : crypto.randomUUID(),
      ownerTrustId: input.ownerTrustId,
      title: input.title,
      body: input.body,
      silent: false,
      metadata: { type: input.type, ...(input.payload ?? {}) },
    });
  }

  return prisma.securityNotification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      payload: JSON.stringify(input.payload ?? {}),
    },
  });
}

export async function listSecurityNotifications(
  userId: string,
  limit = 40,
  ownerTrustId?: string,
) {
  const elfcom = getElfComClient();
  if (elfcom.bound && ownerTrustId) {
    const remote = await elfcom.listNotifications(ownerTrustId);
    if (remote.ok && remote.data) {
      return {
        items: remote.data.items.slice(0, limit),
        unread: remote.data.unread,
        via: "elfcom" as const,
      };
    }
  }

  const rows = await prisma.securityNotification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const items = rows.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    payload: JSON.parse(n.payload) as Record<string, unknown>,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }));
  const unread = items.filter((n) => !n.readAt).length;
  return { items, unread, via: "local_fallback" as const };
}

export async function markNotificationRead(
  userId: string,
  id: string,
  ownerTrustId?: string,
) {
  const elfcom = getElfComClient();
  if (elfcom.bound && ownerTrustId) {
    const remote = await elfcom.markNotificationRead(ownerTrustId, id);
    if (remote.ok) return { ok: true, via: "elfcom" as const };
  }

  const row = await prisma.securityNotification.findFirst({
    where: { id, userId },
  });
  if (!row) {
    throw Object.assign(new Error("Notification not found"), { statusCode: 404 });
  }
  await prisma.securityNotification.update({
    where: { id },
    data: { readAt: new Date() },
  });
  return { ok: true, via: "local_fallback" as const };
}

export async function unreadNotificationCount(userId: string) {
  return prisma.securityNotification.count({
    where: { userId, readAt: null },
  });
}
