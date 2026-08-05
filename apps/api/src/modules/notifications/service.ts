import { prisma } from "../../db/client.js";

export async function createSecurityNotification(input: {
  userId: string;
  type: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}) {
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

export async function listSecurityNotifications(userId: string, limit = 40) {
  const rows = await prisma.securityNotification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    payload: JSON.parse(n.payload) as Record<string, unknown>,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }));
}

export async function markNotificationRead(userId: string, id: string) {
  const row = await prisma.securityNotification.findFirst({
    where: { id, userId },
  });
  if (!row) {
    throw Object.assign(new Error("Notification not found"), { statusCode: 404 });
  }
  return prisma.securityNotification.update({
    where: { id },
    data: { readAt: new Date() },
  });
}

export async function unreadNotificationCount(userId: string) {
  return prisma.securityNotification.count({
    where: { userId, readAt: null },
  });
}
