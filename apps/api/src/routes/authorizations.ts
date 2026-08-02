import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import {
  grantAuthorization,
  listAuthorizations,
  revokeAuthorization,
} from "../modules/authorization/service.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string };
  return reply.code(e.statusCode ?? 500).send({
    error: "invalid_request",
    message: e.message ?? "Unexpected error",
  });
}

export async function authorizationRoutes(app: FastifyInstance) {
  app.get("/authorizations", { preHandler: requireSession }, async (req) => {
    return listAuthorizations(req.auth!.userId);
  });

  app.post("/authorizations", { preHandler: requireSession }, async (req, reply) => {
    const body = z
      .object({
        applicationId: z.string().min(1),
        scopes: z.array(z.string()).min(1),
      })
      .parse(req.body);
    try {
      const id = await grantAuthorization({
        userId: req.auth!.userId,
        applicationId: body.applicationId,
        scopes: body.scopes,
        ...clientMeta(req),
      });
      return { id, ok: true };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.delete("/authorizations/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    try {
      await revokeAuthorization(req.auth!.userId, params.id, clientMeta(req));
      return { ok: true };
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
