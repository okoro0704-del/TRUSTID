import type { FastifyInstance } from "fastify";
import { requireSession } from "../lib/auth-context.js";
import { getTrustCenterSummary, computeTrustLevel } from "../modules/trust/service.js";

export async function trustRoutes(app: FastifyInstance) {
  app.get("/trust/summary", { preHandler: requireSession }, async (req) => {
    return getTrustCenterSummary(req.auth!.userId, req.auth!.sessionId);
  });

  app.get("/trust/level", { preHandler: requireSession }, async (req) => {
    return computeTrustLevel(req.auth!.userId);
  });
}
