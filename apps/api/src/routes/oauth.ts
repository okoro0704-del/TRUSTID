import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession, tryResolveSession } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import { randomToken } from "../lib/crypto.js";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  parseScopeParam,
  resolveAccessToken,
  validateAuthorizationRequest,
} from "../modules/authorization/service.js";
import {
  bindAuthorizationTransaction,
  createAuthorizationTransaction,
  denyAuthorizationTransaction,
  getAuthorizationTransactionForBrowser,
} from "../modules/authorization/transaction-store.js";
import { ID_TOKEN_SIGNING_ALGS } from "../modules/authorization/id-token.js";
import { getIdentityForUser } from "../modules/identity/service.js";
import { prisma } from "../db/client.js";

const authorizeQuerySchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(43),
  code_challenge_method: z.literal("S256"),
  /** OIDC nonce: returned unchanged in the id_token for the client to check. */
  nonce: z.string().min(1).max(256).optional(),
  /** OIDC-style: "consent" forces Allow UI; "login" forces re-auth (Continue). */
  prompt: z.string().optional(),
  login_hint: z.string().optional(),
  auth_mode: z.string().optional(),
  lifeos_returning: z.string().optional(),
  phone_hint: z.string().optional(),
  device_name: z.string().optional(),
  /** LifeOS silent enter — Continue suppresses status chrome and auto-starts passkey. */
  ui_mode: z.string().optional(),
});

const transactionRefSchema = z.object({ transaction: z.string().min(20).max(256) });
const consentDecisionSchema = transactionRefSchema.extend({ approve: z.boolean() });
const BINDING_COOKIE = "trustid_oauth_binding";
const CSRF_COOKIE = "trustid_oauth_csrf";

function setTransactionCookies(reply: import("fastify").FastifyReply, binding: string, csrf: string) {
  const base = { path: "/", sameSite: config.isDev ? "lax" as const : "none" as const, secure: !config.isDev, maxAge: 10 * 60 };
  reply.setCookie(BINDING_COOKIE, binding, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

function transactionBinding(req: FastifyRequest) {
  const binding = req.cookies[BINDING_COOKIE];
  if (!binding) throw Object.assign(new Error("invalid_authorization_transaction"), { statusCode: 400 });
  return binding;
}

function requireTransactionCsrf(req: FastifyRequest) {
  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.headers["x-trustid-oauth-csrf"];
  if (!cookie || typeof header !== "string" || header !== cookie) {
    throw Object.assign(new Error("invalid_csrf"), { statusCode: 403 });
  }
}

function forceConsentUi(prompt?: string | null): boolean {
  if (!prompt) return false;
  return prompt
    .split(/[\s+]+/)
    .map((p) => p.trim().toLowerCase())
    .includes("consent");
}

function buildRedirectWithCode(redirectUri: string, code: string, state?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

async function issueSessionCode(
  req: FastifyRequest,
  input: {
    userId: string;
    clientId: string;
    redirectUri: string;
    scope?: string;
    state?: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    nonce?: string;
    sessionId?: string;
  },
): Promise<string> {
  const scopes = parseScopeParam(input.scope);
  const { code } = await createAuthorizationCode({
    userId: input.userId,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scopes,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    nonce: input.nonce,
    authTime: await sessionAuthTime(input.sessionId),
  });
  void clientMeta(req);
  return buildRedirectWithCode(input.redirectUri, code, input.state);
}

/** When the TrustID session behind this authorization started (id_token auth_time). */
async function sessionAuthTime(sessionId?: string): Promise<Date | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { createdAt: true } });
  return session?.createdAt ?? null;
}

/**
 * Public OIDC issuer for discovery documents.
 * @see config.oidcIssuer
 */
export async function oauthRoutes(app: FastifyInstance) {
  app.get("/.well-known/openid-configuration", async () => {
    const issuer = config.oidcIssuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      // id_token: signed with the jwks_uri key, aud = requesting client_id.
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [...ID_TOKEN_SIGNING_ALGS],
      claims_supported: ["iss", "sub", "aud", "azp", "exp", "iat", "jti", "nonce", "auth_time"],
      scopes_supported: [
        "openid",
        "identity.basic",
        "identity.zk_claims",
        "identity.trust_level",
        "identity.verification_status",
        "identity.profile",
        "identity.email",
        "identity.phone",
        "identity.portrait",
        "identity.step_up",
        "offline_access",
      ],
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    };
  });

  app.get("/oauth/authorize", async (req, reply) => {
    const query = authorizeQuerySchema.parse(req.query);

    const appRow = await prisma.application.findUnique({
      where: { clientId: query.client_id },
    });
    if (!appRow) {
      return reply.code(400).send({ error: "invalid_client" });
    }

    // S2 is an explicitly opt-in, non-production preparation path. S3 owns
    // the atomic transaction claim + authorization-code issuance transition.
    if (config.oauthTransactionIntegrationEnabled) {
      try {
        const validated = await validateAuthorizationRequest({
          clientId: query.client_id,
          redirectUri: query.redirect_uri,
          scopes: parseScopeParam(query.scope),
          codeChallenge: query.code_challenge,
          codeChallengeMethod: query.code_challenge_method,
        });
        const binding = randomToken(32);
        const csrf = randomToken(32);
        const { handle } = await createAuthorizationTransaction({
          applicationId: validated.application.id,
          redirectUri: query.redirect_uri,
          scopes: validated.scopes,
          state: query.state,
          codeChallenge: query.code_challenge,
          nonce: query.nonce,
          preAuthBinding: binding,
        });
        setTransactionCookies(reply, binding, csrf);
        return reply.redirect(`${config.webauthn.origin}/oauth/consent?transaction=${encodeURIComponent(handle)}`);
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "invalid_request" });
      }
    }

    // Already signed in → issue code and return to the app (no Allow screen).
    // prompt=consent still forces the Authorize UI below.
    if (!forceConsentUi(query.prompt)) {
      const session = await tryResolveSession(req);
      if (session) {
        try {
          const redirectTo = await issueSessionCode(req, {
            userId: session.userId,
            clientId: query.client_id,
            redirectUri: query.redirect_uri,
            scope: query.scope,
            state: query.state,
            codeChallenge: query.code_challenge,
            codeChallengeMethod: query.code_challenge_method,
            nonce: query.nonce,
            sessionId: session.sessionId,
          });
          return reply.redirect(redirectTo);
        } catch {
          /* fall through to consent / login path */
        }
      }
    }

    const params = new URLSearchParams({
      client_id: query.client_id,
      redirect_uri: query.redirect_uri,
      scope: query.scope ?? "",
      state: query.state ?? "",
      code_challenge: query.code_challenge,
      code_challenge_method: query.code_challenge_method,
      app_name: appRow.name,
    });
    if (query.nonce) params.set("nonce", query.nonce);
    if (query.prompt) params.set("prompt", query.prompt);
    if (query.login_hint) params.set("login_hint", query.login_hint);
    if (query.auth_mode) params.set("auth_mode", query.auth_mode);
    if (query.lifeos_returning) params.set("lifeos_returning", query.lifeos_returning);
    if (query.phone_hint) params.set("phone_hint", query.phone_hint);
    if (query.device_name) params.set("device_name", query.device_name);
    if (query.ui_mode) params.set("ui_mode", query.ui_mode);

    const consentUrl = `${config.webauthn.origin}/oauth/consent?${params.toString()}`;
    return reply.redirect(consentUrl);
  });

  /**
   * After passkey / Continue, Consent UI calls this to finish OAuth without an Allow screen.
   * prompt=consent still returns needsConsent so the Authorize UI can be shown.
   */
  app.get("/oauth/consent/transaction", async (req, reply) => {
    if (!config.oauthTransactionIntegrationEnabled) return reply.code(404).send({ error: "not_found" });
    try {
      const { transaction } = transactionRefSchema.parse(req.query);
      const row = await getAuthorizationTransactionForBrowser(transaction, transactionBinding(req));
      const application = await prisma.application.findUnique({ where: { id: row.applicationId } });
      if (!application || application.status !== "active") throw Object.assign(new Error("invalid_client"), { statusCode: 400 });
      return { application: { name: application.name }, scopes: JSON.parse(row.scopes) as string[] };
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "invalid_request" });
    }
  });

  app.post("/oauth/consent/resume", { preHandler: requireSession }, async (req, reply) => {
    if (config.oauthTransactionIntegrationEnabled) {
      try {
        const { transaction } = transactionRefSchema.parse(req.body);
        const row = await bindAuthorizationTransaction(transaction, transactionBinding(req), req.auth!.userId, req.auth!.sessionId!);
        return { needsConsent: true as const, transaction: row.id };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "invalid_request" });
      }
    }
    const body = z
      .object({
        client_id: z.string(),
        redirect_uri: z.string().url(),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string(),
        code_challenge_method: z.literal("S256"),
        nonce: z.string().min(1).max(256).optional(),
        prompt: z.string().optional(),
      })
      .parse(req.body);

    if (forceConsentUi(body.prompt)) {
      return { needsConsent: true as const };
    }

    try {
      const redirectTo = await issueSessionCode(req, {
        userId: req.auth!.userId,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scope: body.scope,
        state: body.state,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
        nonce: body.nonce,
        sessionId: req.auth!.sessionId,
      });
      return { redirectTo, needsConsent: false as const };
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      return reply.code(e.statusCode ?? 400).send({
        error: e.message ?? "invalid_request",
      });
    }
  });

  app.post("/oauth/consent", { preHandler: requireSession }, async (req, reply) => {
    if (config.oauthTransactionIntegrationEnabled) {
      try {
        requireTransactionCsrf(req);
        const { transaction, approve } = consentDecisionSchema.parse(req.body);
        const row = await getAuthorizationTransactionForBrowser(transaction, transactionBinding(req));
        if (row.sessionId !== req.auth!.sessionId || row.userId !== req.auth!.userId) {
          throw Object.assign(new Error("invalid_authorization_transaction"), { statusCode: 400 });
        }
        if (!approve) {
          await denyAuthorizationTransaction(transaction, req.auth!.sessionId!);
          const url = new URL(row.redirectUri);
          url.searchParams.set("error", "access_denied");
          if (row.state) url.searchParams.set("state", row.state);
          return { redirectTo: url.toString() };
        }
        // Never issue a code here. S3 will atomically claim this row and create
        // the authorization code in one Prisma transaction.
        return reply.code(409).send({ error: "authorization_transaction_issuance_pending" });
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "invalid_request" });
      }
    }
    const body = z
      .object({
        client_id: z.string(),
        redirect_uri: z.string().url(),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string(),
        code_challenge_method: z.literal("S256"),
        nonce: z.string().min(1).max(256).optional(),
        approve: z.boolean(),
      })
      .parse(req.body);

    if (!body.approve) {
      const url = new URL(body.redirect_uri);
      url.searchParams.set("error", "access_denied");
      if (body.state) url.searchParams.set("state", body.state);
      return { redirectTo: url.toString() };
    }

    try {
      const { code } = await createAuthorizationCode({
        userId: req.auth!.userId,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scopes: parseScopeParam(body.scope),
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
        nonce: body.nonce,
        authTime: await sessionAuthTime(req.auth!.sessionId),
      });
      void clientMeta(req);
      return {
        redirectTo: buildRedirectWithCode(body.redirect_uri, code, body.state),
      };
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      return reply.code(e.statusCode ?? 400).send({
        error: e.message ?? "invalid_request",
      });
    }
  });

  app.post("/oauth/token", async (req, reply) => {
    const body = z
      .object({
        grant_type: z.literal("authorization_code"),
        code: z.string(),
        redirect_uri: z.string().url(),
        client_id: z.string(),
        client_secret: z.string().optional(),
        code_verifier: z.string().min(43),
      })
      .parse(req.body);

    try {
      return await exchangeAuthorizationCode({
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        clientSecret: body.client_secret,
      });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      return reply.code(e.statusCode ?? 400).send({
        error: e.message ?? "invalid_request",
      });
    }
  });

  app.get("/oauth/userinfo", async (req, reply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "invalid_token" });
    }
    const access = await resolveAccessToken(header.slice(7).trim());
    if (!access) {
      return reply.code(401).send({ error: "invalid_token" });
    }
    return getIdentityForUser(access.userId, access.scopes);
  });
}
