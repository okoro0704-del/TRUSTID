import type { FastifyInstance } from "fastify";
import { requireAuth, requireSession } from "../lib/auth-context.js";
import {
  BbsError,
  bbsConfirmSchema,
  bbsInitiateSchema,
  bbsVerifySchema,
  confirmBbsStepUp,
  getBbsChallengeStatus,
  initiateBbsStepUp,
  verifyBbsStepUpProof,
} from "../modules/bbs/index.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  if (err instanceof BbsError) {
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

export async function bbsRoutes(app: FastifyInstance) {
  app.post("/bbs/step-up/initiate", { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.auth!.via !== "bearer") {
        return reply.code(403).send({
          error: "forbidden",
          message: "BBS step-up requires an OAuth access token",
        });
      }
      const body = bbsInitiateSchema.parse(req.body ?? {});
      return await initiateBbsStepUp({
        userId: req.auth!.userId,
        applicationId: req.auth!.applicationId,
        scopes: req.auth!.scopes ?? [],
        body,
        deviceId: null,
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post(
    "/bbs/step-up/:challengeId/confirm",
    { preHandler: requireSession },
    async (req, reply) => {
      try {
        const params = req.params as { challengeId: string };
        bbsConfirmSchema.parse(req.body ?? {});
        const result = await confirmBbsStepUp({
          userId: req.auth!.userId,
          challengeId: params.challengeId,
          deviceId: req.auth!.deviceId,
        });
        return result;
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post("/bbs/step-up/verify", async (req, reply) => {
    try {
      const body = bbsVerifySchema.parse(req.body ?? {});
      return await verifyBbsStepUpProof(body);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/bbs/step-up/:challengeId/status", async (req, reply) => {
    try {
      const params = req.params as { challengeId: string };
      const header = req.headers.authorization;
      let userId: string | undefined;
      if (header?.startsWith("Bearer ")) {
        const { resolveAccessToken } = await import(
          "../modules/authorization/service.js"
        );
        const access = await resolveAccessToken(header.slice(7).trim());
        userId = access?.userId;
      }
      return await getBbsChallengeStatus(params.challengeId, userId);
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
