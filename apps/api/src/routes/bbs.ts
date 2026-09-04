import type { FastifyInstance } from "fastify";
import { requireAuth, requireSession } from "../lib/auth-context.js";
import { getFinProvClient } from "../modules/baas/registry.js";
import {
  BbsError,
  bbsConfirmSchema,
  bbsInitiateSchema,
  bbsVerifySchema,
} from "../modules/bbs/index.js";
import {
  EmbeddedFinProvClient,
} from "../modules/bbs/finprov-embedded.js";
import { config } from "../lib/config.js";

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

function fromBaas(
  result: { ok: boolean; data?: unknown; error?: string; statusCode?: number },
  reply: import("fastify").FastifyReply,
) {
  if (!result.ok) {
    return reply.code(result.statusCode ?? 502).send({
      error: "finprov_error",
      message: result.error ?? "FinProv call failed",
      via: config.finprov.mode,
    });
  }
  return result.data;
}

/**
 * BBS routes are a thin FinProv consumer facade.
 * Identity assertions stay on TrustID; payment challenge lifecycle belongs to FinProv.
 */
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
      const finprov = getFinProvClient();
      const accessToken =
        (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();

      if (finprov instanceof EmbeddedFinProvClient) {
        return fromBaas(
          await finprov.initiateStepUp({
            accessToken,
            userId: req.auth!.userId,
            applicationId: req.auth!.applicationId,
            scopes: req.auth!.scopes ?? [],
            deviceId: null,
            body,
            ...body,
          }),
          reply,
        );
      }

      return fromBaas(
        await finprov.initiateStepUp({
          accessToken,
          ...body,
        }),
        reply,
      );
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
        const finprov = getFinProvClient();
        return fromBaas(
          await finprov.confirmStepUp(params.challengeId, "", {
            userId: req.auth!.userId,
            deviceId: req.auth!.deviceId,
          }),
          reply,
        );
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post("/bbs/step-up/verify", async (req, reply) => {
    try {
      const body = bbsVerifySchema.parse(req.body ?? {});
      const finprov = getFinProvClient();
      return fromBaas(await finprov.verifyStepUp(body), reply);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/bbs/step-up/:challengeId/status", async (req, reply) => {
    try {
      const params = req.params as { challengeId: string };
      const header = req.headers.authorization;
      let userId: string | undefined;
      let accessToken: string | undefined;
      if (header?.startsWith("Bearer ")) {
        accessToken = header.slice(7).trim();
        const { resolveAccessToken } = await import(
          "../modules/authorization/service.js"
        );
        const access = await resolveAccessToken(accessToken);
        userId = access?.userId;
      }
      const finprov = getFinProvClient();
      if (finprov instanceof EmbeddedFinProvClient) {
        return fromBaas(
          await finprov.getChallengeStatus(params.challengeId, accessToken, userId),
          reply,
        );
      }
      return fromBaas(
        await finprov.getChallengeStatus(params.challengeId, accessToken),
        reply,
      );
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
