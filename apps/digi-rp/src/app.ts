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
  generateAuthoritySigningKey,
  parseActorKey,
  type AuthorityStore,
} from "@trustid/digi-authority";

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
  const signingKey = await generateAuthoritySigningKey(
    process.env.DIGI_AUTHORITY_KID?.trim() || "auth-1"
  );
  const authority =
    opts.authorityService ??
    new AuthorityService({
      store: authorityStore,
      signingKey,
      policies: [DIGITAL_TWIN_MRFUNDZMAN_POLICY],
    });

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
    authority: authority.getHealth(),
  }));

  app.get("/.well-known/authority-jwks.json", async () =>
    authority.getPublicJwks()
  );

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
    return { decision: "ALLOW", grantId: result.grantId, jti: result.jti };
  });

  return { app, auditLog, audience, owners, replay, sessions, authority };
}
