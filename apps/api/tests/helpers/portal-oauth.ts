import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SCOPES } from "@trustid/shared";
import { bootstrapPortalClients } from "../../src/lib/bootstrap-oauth-apps.js";
import { PORTAL_OAUTH_CLIENTS } from "../../src/lib/portal-oauth-clients.js";
import { createAuthorizationCode } from "../../src/modules/authorization/service.js";
import { createSession } from "../../src/modules/sessions/service.js";
import { createZeroPiiUser } from "./zero-pii-user.js";

export const PORTAL = PORTAL_OAUTH_CLIENTS[0]!;
export const ADMIN = PORTAL_OAUTH_CLIENTS[1]!;
export const BUSINESS = PORTAL_OAUTH_CLIENTS[2]!;

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export const digest = (s: string) => createHash("sha256").update(s).digest("base64url");

export async function portalUser(email = `${randomBytes(6).toString("hex")}@example.test`) {
  await bootstrapPortalClients(() => undefined);
  const user = await createZeroPiiUser(email);
  const { session, token: sessionToken } = await createSession({ userId: user.id });
  return { user, session, sessionToken };
}

/** Full authorization-code + PKCE flow against the real token endpoint. */
export async function portalTokens(
  app: FastifyInstance,
  userId: string,
  opts: { client?: (typeof PORTAL_OAUTH_CLIENTS)[number]; scopes?: string[]; nonce?: string } = {},
) {
  const client = opts.client ?? PORTAL;
  const { verifier, challenge } = pkcePair();
  const { code } = await createAuthorizationCode({
    userId,
    clientId: client.clientId,
    redirectUri: client.redirectUris[0]!,
    scopes: opts.scopes ?? [SCOPES.OPENID, SCOPES.IDENTITY_BASIC, SCOPES.IDENTITY_STEP_UP],
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    nonce: opts.nonce ?? null,
  });
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUris[0],
      client_id: client.clientId,
      code_verifier: verifier,
    },
  });
  if (res.statusCode !== 200) throw new Error(`token exchange failed: ${res.statusCode} ${res.body}`);
  return res.json() as { access_token: string; id_token?: string; scope: string };
}
