import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AUDIT_EVENTS } from "@trustid/shared";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import { prisma } from "../db/client.js";
import {
  listSessions,
  revokeAllSessions,
  revokeSession,
} from "../modules/sessions/service.js";

const LOGIN_TYPES = [
  AUDIT_EVENTS.DEVICE_AUTHENTICATION_COMPLETED,
  AUDIT_EVENTS.DEVICE_AUTHENTICATION_FAILED,
  AUDIT_EVENTS.SESSION_CREATED,
  AUDIT_EVENTS.DEVICE_REGISTRATION_COMPLETED,
];

export async function securityRoutes(app: FastifyInstance) {
  app.get("/security/events", { preHandler: requireSession }, async (req) => {
    const query = z
      .object({
        type: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().min(1).max(200).optional(),
      })
      .parse(req.query);

    const where: {
      userId: string;
      type?: string;
      createdAt?: { gte?: Date; lte?: Date };
    } = { userId: req.auth!.userId };
    if (query.type) where.type = query.type;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const events = await prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 50,
    });
    return events.map((e) => ({
      id: e.id,
      type: e.type,
      actorType: e.actorType,
      metadata: JSON.parse(e.metadata) as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
    }));
  });

  app.get("/security/login-history", { preHandler: requireSession }, async (req) => {
    const events = await prisma.auditEvent.findMany({
      where: {
        userId: req.auth!.userId,
        type: { in: [...LOGIN_TYPES] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return events.map((e) => {
      const metadata = JSON.parse(e.metadata) as Record<string, unknown>;
      const success =
        e.type === AUDIT_EVENTS.DEVICE_AUTHENTICATION_FAILED ? false : true;
      return {
        id: e.id,
        time: e.createdAt.toISOString(),
        type: e.type,
        result: success ? "Success" : "Failed",
        method: "passkey",
        deviceId: (metadata.deviceId as string) ?? null,
        application: "TrustID",
        userAgent: e.userAgent,
        ip: e.ip,
      };
    });
  });

  app.get("/sessions", { preHandler: requireSession }, async (req) => {
    const sessions = await listSessions(req.auth!.userId);
    return sessions.map((s) => ({
      ...s,
      current: s.id === req.auth!.sessionId,
      browser: guessBrowser(s.userAgent),
      location: "Approximate location unavailable",
    }));
  });

  app.delete("/sessions/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const ok = await revokeSession(params.id, req.auth!.userId, clientMeta(req));
    if (!ok) {
      return reply.code(404).send({ error: "not_found", message: "Session not found" });
    }
    return { ok: true };
  });

  app.post("/sessions/revoke-all", { preHandler: requireSession }, async (req) => {
    const count = await revokeAllSessions(
      req.auth!.userId,
      req.auth!.sessionId,
      clientMeta(req),
    );
    return { revoked: count };
  });
}

function guessBrowser(ua: string | null) {
  if (!ua) return "Unknown browser";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  return "Browser";
}

