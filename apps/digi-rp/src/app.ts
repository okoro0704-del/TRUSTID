import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  createJwksCache,
  createMemoryOwnerStore,
  createMemoryReplayStore,
  createMemorySessionStore,
  exchangeTrustIdAssertion,
  resolveDigiAudience,
  type DigiAuditSink,
  type OwnerStore,
  type ReplayStore,
  type SessionStore,
} from "@trustid/digi-bridge";

export type DigiRpOptions = {
  trustIdIssuer: string;
  jwksUrl: string;
  digiAudience?: string;
  cookieSecret?: string;
  owners?: OwnerStore;
  replay?: ReplayStore;
  sessions?: SessionStore;
  fetchImpl?: typeof fetch;
  audit?: DigiAuditSink;
};

export async function buildDigiRp(opts: DigiRpOptions) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, {
    secret: opts.cookieSecret ?? "digi-rp-dev-cookie-secret",
  });

  const audience = opts.digiAudience ?? resolveDigiAudience(process.env.NODE_ENV);
  const jwks = createJwksCache({
    jwksUrl: opts.jwksUrl,
    fetchImpl: opts.fetchImpl,
  });
  const owners = opts.owners ?? createMemoryOwnerStore();
  const replay = opts.replay ?? createMemoryReplayStore();
  const sessions = opts.sessions ?? createMemorySessionStore();
  const auditLog: Array<{ event: string; meta: Record<string, unknown> }> = [];
  const audit: DigiAuditSink = opts.audit ?? {
    record(event, meta) {
      auditLog.push({ event, meta });
    },
  };

  app.get("/health", async () => ({
    ok: true,
    service: "digi-rp",
    trustBridge: {
      status: "READY",
      issuer: opts.trustIdIssuer,
      digiAudienceConfigured: true,
      digiAudience: audience,
      jwksUrl: opts.jwksUrl,
    },
  }));

  app.post("/auth/trustid/exchange", async (req, reply) => {
    const body = z.object({ assertion: z.string().min(20) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const result = await exchangeTrustIdAssertion({
      assertion: body.data.assertion,
      expectedIssuer: opts.trustIdIssuer,
      expectedAudience: audience,
      jwks,
      owners,
      replay,
      sessions,
      audit,
    });

    if (!result.ok) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Invalid TrustID assertion",
      });
    }

    const secure = process.env.NODE_ENV === "production";
    reply.setCookie("digi_session", result.sessionToken, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "lax",
      expires: new Date(result.expiresAt),
    });

    return {
      ok: true,
      ownerId: result.ownerId,
      ownerCreated: result.ownerCreated,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
      sessionToken: result.sessionToken,
    };
  });

  app.get("/me", async (req, reply) => {
    const token =
      (typeof req.cookies.digi_session === "string"
        ? req.cookies.digi_session
        : null) ||
      (typeof req.headers.authorization === "string" &&
      req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const session = await sessions.resolve(token);
    if (!session) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      ownerId: session.ownerId,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    };
  });

  return { app, auditLog, audience, owners, replay, sessions };
}
