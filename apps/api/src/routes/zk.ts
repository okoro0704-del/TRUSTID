import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SCOPES } from "@trustid/shared";
import {
  getVerificationKey,
  proveTrustTierGte,
  verifyTrustTierGte,
  type TrustTierProof,
} from "@trustid/zk";
import { requireAuth } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import { identitySecretForUser, zkNullifier } from "../lib/crypto.js";
import { computeTrustLevel } from "../modules/trust/service.js";
import { prisma } from "../db/client.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
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
      const scopes = req.auth!.scopes ?? [];
      if (
        !scopes.includes(SCOPES.IDENTITY_ZK_CLAIMS) &&
        !scopes.includes(SCOPES.IDENTITY_TRUST_LEVEL)
      ) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Missing identity.zk_claims or identity.trust_level scope",
        });
      }

      const body = z
        .object({
          claim: z.enum(["trust_tier_gte"]).default("trust_tier_gte"),
          minTier: z.number().int().min(0).max(3).default(1),
          audience: z.string().min(1).max(200).optional(),
        })
        .parse(req.body ?? {});

      const appRow = req.auth!.applicationId
        ? await prisma.application.findUnique({
            where: { id: req.auth!.applicationId },
          })
        : null;
      const audience = body.audience ?? appRow?.clientId ?? "lifeos";

      const trust = await computeTrustLevel(req.auth!.userId);
      const secret = identitySecretForUser(req.auth!.userId);
      const nullifier = zkNullifier(secret, audience);
      const proved = proveTrustTierGte({
        tier: trust.tier,
        minTier: body.minTier,
        nullifier,
        issuerSecret: config.sealKey,
      });

      return {
        ...proved,
        trustIdNullifier: nullifier,
        stars: trust.stars,
        maxStars: trust.maxStars,
        label: trust.label,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/zk/verify", async (req, reply) => {
    try {
      const body = z
        .object({
          proof: z.any(),
          publicSignals: z.array(z.string()).min(3),
        })
        .parse(req.body);

      const result = verifyTrustTierGte({
        proof: body.proof as TrustTierProof["proof"],
        publicSignals: body.publicSignals,
        issuerSecret: config.sealKey,
      });
      return result;
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
