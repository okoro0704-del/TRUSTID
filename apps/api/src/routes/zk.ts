import type { FastifyInstance } from "fastify";
import { getVerificationKey } from "@trustid/zk";
import { requireAuth } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import {
  proveZk,
  verifyZk,
  ZkProveError,
  zkProveRequestSchema,
  zkVerifyRequestSchema,
} from "../modules/zk/index.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  if (err instanceof ZkProveError) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
    });
  }
  const e = err as { statusCode?: number; message?: string };
  return reply.code(e.statusCode ?? 500).send({
    error: "invalid_request",
    message: e.message ?? "Unexpected error",
  });
}

export async function zkRoutes(app: FastifyInstance) {
  app.get("/zk/verification-key", async () => {
    return getVerificationKey(config.sealKey);
  });

  app.post("/zk/prove", { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.auth!.via !== "bearer") {
        return reply.code(403).send({
          error: "forbidden",
          message: "ZK proofs require an OAuth access token",
        });
      }

      const body = zkProveRequestSchema.parse(req.body ?? {});
      const result = await proveZk({
        userId: req.auth!.userId,
        applicationId: req.auth!.applicationId,
        scopes: req.auth!.scopes ?? [],
        body,
      });
      return result;
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/zk/verify", async (req, reply) => {
    try {
      const body = zkVerifyRequestSchema.parse(req.body ?? {});
      return verifyZk(body);
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
