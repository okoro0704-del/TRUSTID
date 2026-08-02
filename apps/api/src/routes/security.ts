import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import { listUserAuditEvents } from "../modules/audit/service.js";
import {
  listSessions,
  revokeAllSessions,
  revokeSession,
} from "../modules/sessions/service.js";

export async function securityRoutes(app: FastifyInstance) {
  app.get("/security/events", { preHandler: requireSession }, async (req) => {
    return listUserAuditEvents(req.auth!.userId);
  });

  app.get("/sessions", { preHandler: requireSession }, async (req) => {
    const sessions = await listSessions(req.auth!.userId);
    return sessions.map((s) => ({
      ...s,
      current: s.id === req.auth!.sessionId,
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
