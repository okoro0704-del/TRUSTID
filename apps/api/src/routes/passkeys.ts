import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import {
  listPasskeys,
  removePasskey,
  renamePasskey,
} from "../modules/passkeys/service.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string };
  return reply.code(e.statusCode ?? 500).send({
    error: "invalid_request",
    message: e.message ?? "Unexpected error",
  });
}

export async function passkeyRoutes(app: FastifyInstance) {
  app.get("/passkeys", { preHandler: requireSession }, async (req) => {
    return listPasskeys(req.auth!.userId);
  });

  app.patch("/passkeys/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ displayName: z.string().min(1).max(100) }).parse(req.body);
    try {
      const updated = await renamePasskey(
        req.auth!.userId,
        params.id,
        body.displayName,
      );
      return {
        id: updated.id,
        displayName: updated.displayName,
        status: updated.status,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.delete("/passkeys/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    try {
      await removePasskey(req.auth!.userId, params.id, clientMeta(req));
      return { ok: true };
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
