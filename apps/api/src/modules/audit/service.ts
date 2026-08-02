import type { AuditEventType } from "@trustid/shared";
import { prisma } from "../../db/client.js";

export async function recordAudit(input: {
  type: AuditEventType | string;
  userId?: string | null;
  actorType: "user" | "system" | "application";
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return prisma.auditEvent.create({
    data: {
      type: input.type,
      userId: input.userId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

export async function listUserAuditEvents(userId: string, limit = 50) {
  const events = await prisma.auditEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    actorType: e.actorType,
    metadata: JSON.parse(e.metadata) as Record<string, unknown>,
    createdAt: e.createdAt.toISOString(),
  }));
}
