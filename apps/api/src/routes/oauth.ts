import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession, tryResolveSession } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  parseScopeParam,
  resolveAccessToken,
} from "../modules/authorization/service.js";
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
  /** OIDC-style: "consent" forces Allow UI; "login" forces re-auth (Continue). */
  prompt: z.string().optional(),
  login_hint: z.string().optional(),
  auth_mode: z.string().optional(),
  lifeos_returning: z.string().optional(),
  phone_hint: z.string().optional(),
  device_name: z.string().optional(),
});

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
  });
  void clientMeta(req);
  return buildRedirectWithCode(input.redirectUri, code, input.state);
}

export async function oauthRoutes(app: FastifyInstance) {
  app.get("/.well-known/openid-configuration", async () => {
    const issuer = `http://localhost:${config.port}`;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [
        "openid",
        "identity.basic",
        "identity.profile",
        "identity.email",
        "identity.phone",
        "offline_access",
      ],
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
    if (query.prompt) params.set("prompt", query.prompt);
    if (query.login_hint) params.set("login_hint", query.login_hint);
    if (query.auth_mode) params.set("auth_mode", query.auth_mode);
    if (query.lifeos_returning) params.set("lifeos_returning", query.lifeos_returning);
    if (query.phone_hint) params.set("phone_hint", query.phone_hint);
    if (query.device_name) params.set("device_name", query.device_name);

    const consentUrl = `${config.webauthn.origin}/oauth/consent?${params.toString()}`;
    return reply.redirect(consentUrl);
  });

  /**
   * After passkey / Continue, Consent UI calls this to finish OAuth without an Allow screen.
   * prompt=consent still returns needsConsent so the Authorize UI can be shown.
   */
  app.post("/oauth/consent/resume", { preHandler: requireSession }, async (req, reply) => {
    const body = z
      .object({
        client_id: z.string(),
        redirect_uri: z.string().url(),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string(),
        code_challenge_method: z.literal("S256"),
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
    const body = z
      .object({
        client_id: z.string(),
        redirect_uri: z.string().url(),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string(),
        code_challenge_method: z.literal("S256"),
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
