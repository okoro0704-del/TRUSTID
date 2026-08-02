import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth-context.js";
import {
  getDashboardIdentity,
  getIdentityForUser,
} from "../modules/identity/service.js";

export async function identityRoutes(app: FastifyInstance) {
  app.get("/identity", { preHandler: requireAuth }, async (req) => {
    if (req.auth!.via === "bearer") {
      return getIdentityForUser(req.auth!.userId, req.auth!.scopes);
    }
    return getDashboardIdentity(req.auth!.userId);
  });
}
