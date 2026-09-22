import type { FastifyInstance, FastifyRequest } from "fastify";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import { issueDigiSubjectAssertion } from "../modules/trust-bridge/digi-assertion.js";
import { getTrustCenterSummary, computeTrustLevel } from "../modules/trust/service.js";

function originAllowed(req: FastifyRequest): boolean {
  // Header/bearer session (native / same-process tests) — no Origin required.
  if (req.auth?.via === "bearer") return true;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!origin) {
    // Same-site navigations may omit Origin; allow when Sec-Fetch-Site is same-origin/none.
    const site = String(req.headers["sec-fetch-site"] ?? "");
    if (site === "same-origin" || site === "none" || site === "") return true;
    return false;
  }
  return config.webauthn.origins.includes(origin) || config.corsOrigins.includes(origin);
}

export async function trustRoutes(app: FastifyInstance) {
  app.get("/trust/summary", { preHandler: requireSession }, async (req) => {
    return getTrustCenterSummary(req.auth!.userId, req.auth!.sessionId);
  });

  app.get("/trust/level", { preHandler: requireSession }, async (req) => {
    return computeTrustLevel(req.auth!.userId);
  });

  /**
   * Phase T2 — Digi-targeted subject assertion.
   * Session-authenticated only. Audience is server-fixed (not client-chosen).
   * `sub` always derived from the session identity.
   */
  app.post(
    "/trust/assertions/digi",
    { preHandler: requireSession },
    async (req, reply) => {
      if (!originAllowed(req)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Origin not allowed for Digi assertion issuance",
        });
      }
      const trustId = req.auth!.trustId;
      if (!trustId) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "Session missing Trust ID subject",
        });
      }
      try {
        // Ignore any client body fields that try to set sub/aud.
        return await issueDigiSubjectAssertion({
          userId: req.auth!.userId,
          trustId,
          ...clientMeta(req),
        });
      } catch (err) {
        const e = err as { statusCode?: number; message?: string; code?: string };
        return reply.code(e.statusCode ?? 500).send({
          error: e.code || "server_error",
          message: e.message ?? "Unexpected error",
        });
      }
    },
  );
}
