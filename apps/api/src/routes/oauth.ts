import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  parseScopeParam,
  resolveAccessToken,
} from "../modules/authorization/service.js";
import { getIdentityForUser } from "../modules/identity/service.js";
import { prisma } from "../db/client.js";

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
    const query = z
      .object({
        client_id: z.string(),
        redirect_uri: z.string().url(),
        response_type: z.literal("code"),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string().min(43),
        code_challenge_method: z.literal("S256"),
      })
      .parse(req.query);

    const appRow = await prisma.application.findUnique({
      where: { clientId: query.client_id },
    });
    if (!appRow) {
      return reply.code(400).send({ error: "invalid_client" });
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

    // Consent UI lives on the TrustID PWA
    const consentUrl = `${config.webauthn.origin}/oauth/consent?${params.toString()}`;
    return reply.redirect(consentUrl);
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
      const url = new URL(body.redirect_uri);
      url.searchParams.set("code", code);
      if (body.state) url.searchParams.set("state", body.state);
      return { redirectTo: url.toString() };
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
