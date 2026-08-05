import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import {
  listApplications,
  registerApplication,
} from "../modules/authorization/service.js";
import { DEFAULT_APP_SCOPES } from "@trustid/shared";

function optionalSessionToken(req: {
  cookies?: Record<string, string | undefined>;
  headers: Record<string, unknown>;
}) {
  const header = req.headers.authorization;
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : undefined;
  const custom =
    typeof req.headers["x-trustid-session"] === "string"
      ? (req.headers["x-trustid-session"] as string).trim()
      : undefined;
  return custom || bearer || req.cookies?.[config.sessionCookieName];
}

export async function applicationRoutes(app: FastifyInstance) {
  app.get("/applications", async (req) => {
    // Optional session for connection status (cookie or TrustID session headers)
    const token = optionalSessionToken(req);
    let userId: string | undefined;
    if (token) {
      try {
        const { resolveSession } = await import("../modules/sessions/service.js");
        const session = await resolveSession(token);
        userId = session?.userId;
      } catch {
        /* ignore */
      }
    }
    return listApplications(userId);
  });

  app.post("/applications", { preHandler: requireSession }, async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        type: z.enum(["public", "confidential"]).optional(),
        redirectUris: z.array(z.string().url()).min(1),
        allowedScopes: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return registerApplication({
      name: body.name,
      type: body.type,
      redirectUris: body.redirectUris,
      allowedScopes: body.allowedScopes ?? [...DEFAULT_APP_SCOPES],
    });
  });
}
