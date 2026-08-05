import type { FastifyInstance } from "fastify";
import { prisma } from "../db/client.js";

/**
 * Temporary test helper — wipe all users so emails/phones can be reused.
 * Enabled only when WIPE_SECRET is set. Remove after onboarding works.
 */
export async function wipeRoutes(app: FastifyInstance) {
  app.post("/dev/wipe-users", async (req, reply) => {
    const secret = process.env.WIPE_SECRET;
    if (!secret) {
      return reply.code(404).send({ error: "not_found" });
    }
    const header = req.headers["x-wipe-secret"];
    if (header !== secret) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    // Ignore body — allow empty POSTs from PowerShell without Content-Type issues
    void req.body;

    const deleted = await prisma.user.deleteMany({});
    return { ok: true, deletedUsers: deleted.count };
  });

  app.get("/dev/wipe-users", async (req, reply) => {
    const secret = process.env.WIPE_SECRET;
    if (!secret) {
      return reply.code(404).send({ error: "not_found" });
    }
    const header = req.headers["x-wipe-secret"];
    const querySecret = typeof req.query === "object" && req.query && "secret" in req.query
      ? String((req.query as { secret?: string }).secret ?? "")
      : "";
    if (header !== secret && querySecret !== secret) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const deleted = await prisma.user.deleteMany({});
    return { ok: true, deletedUsers: deleted.count };
  });
}
