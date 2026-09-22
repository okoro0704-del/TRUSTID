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
import {
  AuthorityService,
  DIGITAL_TWIN_MRFUNDZMAN_POLICY,
  MemoryAuthorityStore,
  parseActorKey,
  type AuthorityStore,
} from "@trustid/digi-authority";
import { loadAuthoritySigningKey } from "./keys.js";
import type { JWK } from "jose";

export type DigiRpOptions = {
  trustIdIssuer: string;
  jwksUrl: string;
  digiAudience?: string;
  cookieSecret?: string;
  owners?: OwnerStore;
  replay?: ReplayStore;
  sessions?: SessionStore;
  authorityStore?: AuthorityStore;
  authorityService?: AuthorityService;
  authorityPersistence?: "postgres" | "sqlite" | "memory";
  authorityPublicJwks?: JWK[];
  fetchImpl?: typeof fetch;
  audit?: DigiAuditSink;
};

async function resolveSessionOwner(
  sessions: SessionStore,
  req: {
    cookies: Record<string, string | undefined>;
    headers: { authorization?: string };
  }
): Promise<string | null> {
  const token =
    (typeof req.cookies.digi_session === "string"
      ? req.cookies.digi_session
      : null) ||
    (typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);
  if (!token) return null;
  const session = await sessions.resolve(token);
  return session?.ownerId ?? null;
}

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

  const authorityStore = opts.authorityStore ?? new MemoryAuthorityStore();
  const loaded = await loadAuthoritySigningKey();
  const publicJwks = opts.authorityPublicJwks ?? loaded.publicJwks;
  const persistence =
    opts.authorityPersistence ??
    (opts.authorityStore ? "memory" : "memory");
  const authority =
    opts.authorityService ??
    new AuthorityService({
      store: authorityStore,
      signingKey: loaded.primary,
      policies: [DIGITAL_TWIN_MRFUNDZMAN_POLICY],
      persistence,
    });

  // Patch JWKS to include rotation previous keys
  const baseJwks = authority.getPublicJwks();
  const mergedKeys = [
    ...baseJwks.keys,
    ...publicJwks.filter(
      (k) => !baseJwks.keys.some((b) => b.kid === k.kid)
    ),
  ];

  app.get("/health", async () => {
    const authHealth = authority.getHealth();
    return {
      ok: authHealth.status === "READY" || authHealth.persistence !== "memory",
      service: "digi-rp",
      trustBridge: {
        status: "READY",
        issuer: opts.trustIdIssuer,
        digiAudienceConfigured: true,
        digiAudience: audience,
        jwksUrl: opts.jwksUrl,
      },
      authority: {
        status: authHealth.status,
        persistence: authHealth.persistence,
        tokenAlg: authHealth.tokenAlg,
        issuer: authHealth.issuer,
        jwks: "READY" as const,
        kid: authHealth.kid,
      },
    };
  });

  app.get("/.well-known/authority-jwks.json", async () => ({
    keys: mergedKeys,
  }));
  // Alias stable path
  app.get("/v1/authority/jwks", async () => ({ keys: mergedKeys }));

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
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const sessionToken =
      (typeof req.cookies.digi_session === "string"
        ? req.cookies.digi_session
        : null) ||
      (typeof req.headers.authorization === "string" &&
      req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);
    const session = sessionToken ? await sessions.resolve(sessionToken) : null;
    return {
      ownerId,
      sessionId: session?.id,
      expiresAt: session?.expiresAt.toISOString(),
    };
  });

  // --- Phase T3 authority APIs ---

  app.post("/authority/check", async (req, reply) => {
    const body = z
      .object({
        ownerId: z.string().min(1).optional(),
        actor: z.string().min(3),
        action: z.string().min(1),
        resource: z.string().min(1),
        audience: z.string().min(1),
        stepUpProvided: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const actor = parseActorKey(body.data.actor);
    if (!actor) {
      return reply.code(400).send({ error: "invalid_actor" });
    }
    const sessionOwner = await resolveSessionOwner(sessions, req);
    const ownerId = body.data.ownerId ?? sessionOwner;
    if (!ownerId) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const result = await authority.check({
      ownerId,
      actor,
      action: body.data.action,
      resource: body.data.resource,
      audience: body.data.audience,
      stepUpProvided: body.data.stepUpProvided,
    });
    return result;
  });

  app.get("/authority/requests/pending", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    return { requests: await authority.listPending(ownerId) };
  });

  app.get("/authority/grants/active", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    return { grants: await authority.listActive(ownerId) };
  });

  app.get("/authority/grants/revoked", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    return { grants: await authority.listRevoked(ownerId) };
  });

  app.get("/authority/grants/:id", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    const grant = await authority.inspect(id);
    if (!grant || grant.ownerId !== ownerId) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { grant };
  });

  app.post("/authority/requests/:id/approve", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    const result = await authority.approveRequest(ownerId, id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }
    return {
      ok: true,
      grantId: result.grant.id,
      token: result.token,
    };
  });

  app.post("/authority/requests/:id/deny", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    const result = await authority.denyRequest(ownerId, id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }
    return { ok: true };
  });

  app.post("/authority/grants/:id/revoke", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    const id = (req.params as { id: string }).id;
    const result = await authority.revoke(ownerId, id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }
    return { ok: true };
  });

  app.post("/authority/token", async (req, reply) => {
    const ownerId = await resolveSessionOwner(sessions, req);
    if (!ownerId) return reply.code(401).send({ error: "unauthorized" });
    const body = z
      .object({
        grantId: z.string().min(1),
        actions: z.array(z.string()).optional(),
        resources: z.array(z.string()).optional(),
        ttlSeconds: z.number().int().positive().max(3600).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await authority.issueToken(ownerId, body.data.grantId, {
      actions: body.data.actions,
      resources: body.data.resources,
      ttlSeconds: body.data.ttlSeconds,
    });
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }
    return {
      token: result.token,
      jti: result.jti,
      exp: result.exp,
    };
  });

  app.post("/authority/use", async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(20),
        audience: z.string().min(1),
        actor: z.string().min(3),
        action: z.string().min(1),
        resource: z.string().min(1),
        correlationId: z.string().optional(),
        actionId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await authority.useToken({
      token: body.data.token,
      expectedAudience: body.data.audience,
      expectedActor: body.data.actor,
      expectedAction: body.data.action,
      expectedResource: body.data.resource,
    });
    if (!result.ok) {
      return reply.code(403).send({ decision: "DENY", reason: result.reason });
    }
    return {
      decision: "ALLOW",
      grantId: result.grantId,
      jti: result.jti,
      correlationId: body.data.correlationId ?? null,
      actionId: body.data.actionId ?? null,
    };
  });

  /** Consumer-facing consume alias (Option A: Digi-side shared consumption). */
  app.post("/v1/authority/consume", async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(20),
        audience: z.string().min(1),
        actor: z.string().min(3),
        action: z.string().min(1),
        resource: z.string().min(1),
        correlationId: z.string().optional(),
        actionId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await authority.useToken({
      token: body.data.token,
      expectedAudience: body.data.audience,
      expectedActor: body.data.actor,
      expectedAction: body.data.action,
      expectedResource: body.data.resource,
    });
    if (!result.ok) {
      return reply.code(403).send({
        decision: "DENY",
        reason: result.reason,
        correlationId: body.data.correlationId ?? null,
      });
    }
    return {
      decision: "ALLOW",
      grantId: result.grantId,
      jti: result.jti,
      correlationId: body.data.correlationId ?? null,
      actionId: body.data.actionId ?? null,
    };
  });

  return { app, auditLog, audience, owners, replay, sessions, authority };
}
