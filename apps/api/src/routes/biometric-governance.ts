/**
 * INTERNAL read-only biometric retrieval governance surface.
 * Gate: EVAL_BIOMETRIC_SECRET via header x-eval-biometric-secret (same internal
 * secret as the evaluation collector). Absent secret -> 404.
 * GET only: nothing here can change production configuration, and responses
 * contain policy values only (no embeddings, identities, or media).
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db/client.js";
import { isPgVectorEnabled } from "../lib/pgvector.js";
import { enrollmentSerializationBackend } from "../modules/trust-id/enrollment-serialization.js";
import { biometricRetrievalPolicy } from "../modules/trust-id/retrieval-policy.js";

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = process.env.EVAL_BIOMETRIC_SECRET?.trim();
  if (!secret) {
    void reply.code(404).send({ error: "not_found" });
    return false;
  }
  const header = req.headers["x-eval-biometric-secret"];
  const given = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    void reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

/** Database defaults the search actually runs with. Reads two server settings; no tables, no rows. */
async function observedDatabaseSettings() {
  if (!(await isPgVectorEnabled())) return { observed: false as const, reason: "pgvector_not_enabled" };
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ ef: string | null; st: string | null }>>(
      "SELECT current_setting('hnsw.ef_search', true) AS ef, current_setting('statement_timeout', true) AS st",
    );
    return {
      observed: true as const,
      hnswEfSearchDefault: rows[0]?.ef ?? null,
      statementTimeoutDefault: rows[0]?.st ?? null,
    };
  } catch {
    return { observed: false as const, reason: "settings_query_failed" };
  }
}

export async function biometricGovernanceRoutes(app: FastifyInstance) {
  app.get("/internal/biometric-governance/retrieval-policy", async (req, reply) => {
    if (!authorized(req, reply)) return;
    reply.header("cache-control", "no-store");
    return {
      ...biometricRetrievalPolicy(),
      enrollmentSerialization: enrollmentSerializationBackend(),
      database: await observedDatabaseSettings(),
    };
  });
}
