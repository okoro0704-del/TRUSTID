import type { FastifyInstance } from "fastify";
import { prisma } from "../db/client.js";

/**
 * Temporary test helper — wipe all users / biometric registry so onboarding
 * can start fresh. Enabled only when WIPE_SECRET is set.
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

    void req.body;

    // Explicit registry clear (also cascades from users)
    const deletedEmbeddings = await prisma.biometricEmbedding.deleteMany({});
    const deletedTemplates = await prisma.biometricTemplate.deleteMany({});
    const deleted = await prisma.user.deleteMany({});
    const leftoverDevices = await prisma.device.deleteMany({});
    const leftoverCreds = await prisma.credential.deleteMany({});
    const leftoverInstalls = await prisma.deviceInstall.deleteMany({});
    return {
      ok: true,
      deletedUsers: deleted.count,
      deletedEmbeddings: deletedEmbeddings.count,
      deletedTemplates: deletedTemplates.count,
      deletedDevices: leftoverDevices.count,
      deletedCredentials: leftoverCreds.count,
      deletedInstalls: leftoverInstalls.count,
    };
  });

  app.get("/dev/wipe-users", async (req, reply) => {
    const secret = process.env.WIPE_SECRET;
    if (!secret) {
      return reply.code(404).send({ error: "not_found" });
    }
    const header = req.headers["x-wipe-secret"];
    const querySecret =
      typeof req.query === "object" && req.query && "secret" in req.query
        ? String((req.query as { secret?: string }).secret ?? "")
        : "";
    if (header !== secret && querySecret !== secret) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const deletedEmbeddings = await prisma.biometricEmbedding.deleteMany({});
    const deletedTemplates = await prisma.biometricTemplate.deleteMany({});
    const deleted = await prisma.user.deleteMany({});
    const leftoverDevices = await prisma.device.deleteMany({});
    const leftoverCreds = await prisma.credential.deleteMany({});
    const leftoverInstalls = await prisma.deviceInstall.deleteMany({});
    return {
      ok: true,
      deletedUsers: deleted.count,
      deletedEmbeddings: deletedEmbeddings.count,
      deletedTemplates: deletedTemplates.count,
      deletedDevices: leftoverDevices.count,
      deletedCredentials: leftoverCreds.count,
      deletedInstalls: leftoverInstalls.count,
    };
  });
}
