/**
 * Gate 1 (Portal OAuth clients) and Gate 3 (OIDC id_token).
 * Real Fastify app, real Prisma (SQLite test DB), real EdDSA signing key; no mocks.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import { SCOPES } from "@trustid/shared";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { bootstrapPortalClients } from "../src/lib/bootstrap-oauth-apps.js";
import { PORTAL_CLIENT_SCOPES } from "../src/lib/portal-oauth-clients.js";
import { createAuthorizationCode } from "../src/modules/authorization/service.js";
import { IdTokenError, verifyIdToken } from "../src/modules/authorization/id-token.js";
import { getJwks } from "../src/modules/verified-identity/assertions.js";
import { resetTables } from "./helpers/db.js";
import { ADMIN, BUSINESS, PORTAL, pkcePair, portalTokens, portalUser } from "./helpers/portal-oauth.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  await resetTables(prisma);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("Gate 1: Portal public OAuth clients", () => {
  it("registers the three exact public clients with PKCE-only (no secret) and step-up scope", async () => {
    // buildApp() already ran the boot-time bootstrap; start from an empty client table.
    await prisma.application.deleteMany({ where: { clientId: { startsWith: "lifeos_" } } });
    const result = await bootstrapPortalClients(() => undefined);
    expect(result.map((r) => r.action)).toEqual(["created", "created", "created"]);
    const rows = await prisma.application.findMany({ where: { clientId: { startsWith: "lifeos_" } }, orderBy: { clientId: "asc" } });
    expect(rows.map((r) => [r.clientId, r.type, r.clientSecretHash, JSON.parse(r.redirectUris)])).toEqual([
      ["lifeos_business_portal_public", "public", null, ["https://business.getlifeos.app/callback"]],
      ["lifeos_platform_admin_public", "public", null, ["https://admin.getlifeos.app/callback"]],
      ["lifeos_portal_public", "public", null, ["https://getlifeos.app/callback"]],
    ]);
    for (const r of rows) expect(JSON.parse(r.allowedScopes)).toEqual([...PORTAL_CLIENT_SCOPES]);
  });

  it("is create-only: an existing client registration is never modified", async () => {
    await bootstrapPortalClients(() => undefined);
    await prisma.application.update({
      where: { clientId: PORTAL.clientId },
      data: { redirectUris: JSON.stringify(["https://getlifeos.app/callback", "https://getlifeos.app/alt"]) },
    });
    const logs: string[] = [];
    const again = await bootstrapPortalClients((m) => logs.push(m));
    expect(again.find((r) => r.clientId === PORTAL.clientId)?.action).toBe("differs");
    expect(logs.join(" ")).toMatch(/left unchanged/);
    const row = await prisma.application.findUnique({ where: { clientId: PORTAL.clientId } });
    expect(JSON.parse(row!.redirectUris)).toContain("https://getlifeos.app/alt");
  });

  it("matches redirect URIs exactly (no prefix, trailing slash, other client or TrustID-origin shortcut)", async () => {
    const { user } = await portalUser();
    const { challenge } = pkcePair();
    const base = {
      userId: user.id,
      clientId: PORTAL.clientId,
      scopes: [SCOPES.OPENID],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    };
    for (const redirectUri of [
      "https://getlifeos.app/callback/",
      "https://getlifeos.app/callback?x=1",
      "https://getlifeos.app/callbackx",
      "http://getlifeos.app/callback",
      "https://evil.getlifeos.app/callback",
      ADMIN.redirectUris[0]!,
      `${config.webauthn.origin}/callback`,
    ]) {
      await expect(createAuthorizationCode({ ...base, redirectUri })).rejects.toThrow("invalid_redirect_uri");
    }
    await expect(createAuthorizationCode({ ...base, redirectUri: PORTAL.redirectUris[0]! })).resolves.toBeTruthy();
  });

  it("codes are single-use, expire, need the right PKCE verifier and the client that requested them", async () => {
    const { user } = await portalUser();
    const { verifier, challenge } = pkcePair();
    const { code } = await createAuthorizationCode({
      userId: user.id,
      clientId: PORTAL.clientId,
      redirectUri: PORTAL.redirectUris[0]!,
      scopes: [SCOPES.OPENID],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const exchange = (over: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: {
          grant_type: "authorization_code",
          code,
          redirect_uri: PORTAL.redirectUris[0],
          client_id: PORTAL.clientId,
          code_verifier: verifier,
          ...over,
        },
      });
    expect((await exchange({ code_verifier: pkcePair().verifier })).json()).toMatchObject({ error: "invalid_grant" });
    expect((await exchange({ client_id: ADMIN.clientId, redirect_uri: ADMIN.redirectUris[0]! })).json()).toMatchObject({ error: "invalid_grant" });
    expect((await exchange()).statusCode).toBe(200);
    const second = await exchange();
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ error: "invalid_grant" });

    const { verifier: v2, challenge: c2 } = pkcePair();
    const { code: stale } = await createAuthorizationCode({
      userId: user.id,
      clientId: PORTAL.clientId,
      redirectUri: PORTAL.redirectUris[0]!,
      scopes: [SCOPES.OPENID],
      codeChallenge: c2,
      codeChallengeMethod: "S256",
    });
    await prisma.oAuthAuthorizationCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) }, where: { consumedAt: null } });
    const expired = await exchange({ code: stale, code_verifier: v2 });
    expect(expired.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("/oauth/authorize returns state unchanged and carries nonce + auth_time into the id_token", async () => {
    const { session, sessionToken } = await portalUser();
    const { verifier, challenge } = pkcePair();
    const res = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: PORTAL.clientId,
        redirect_uri: PORTAL.redirectUris[0]!,
        response_type: "code",
        scope: "openid profile",
        state: "st-123",
        nonce: "n-abc",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      cookies: { [config.sessionCookieName]: sessionToken },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(PORTAL.redirectUris[0]);
    expect(location.searchParams.get("state")).toBe("st-123");
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code: location.searchParams.get("code"),
        redirect_uri: PORTAL.redirectUris[0],
        client_id: PORTAL.clientId,
        code_verifier: verifier,
      },
    });
    const body = token.json() as { id_token: string };
    const claims = await verifyIdToken({ idToken: body.id_token, clientId: PORTAL.clientId, nonce: "n-abc" });
    expect(claims.auth_time).toBe(Math.floor(session.createdAt.getTime() / 1000));
  });
});

describe("Gate 3: OIDC id_token", () => {
  async function issued(nonce = "nonce-1") {
    const { user } = await portalUser();
    const tokens = await portalTokens(app, user.id, { nonce });
    return { user, tokens };
  }

  it("is signed with the advertised key and carries iss, sub, aud=client, azp, exp, iat, nonce", async () => {
    const { user, tokens } = await issued();
    expect(tokens.id_token).toBeTruthy();
    const header = jose.decodeProtectedHeader(tokens.id_token!);
    const jwks = await getJwks();
    expect(header.alg).toBe("EdDSA");
    expect(jwks.keys.map((k) => k.kid)).toContain(header.kid);
    const claims = await verifyIdToken({ idToken: tokens.id_token!, clientId: PORTAL.clientId, nonce: "nonce-1" });
    expect(claims).toMatchObject({
      iss: config.oidcIssuer,
      sub: user.trustId,
      aud: PORTAL.clientId,
      azp: PORTAL.clientId,
      nonce: "nonce-1",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it("the correct client accepts it; every other Portal client rejects it", async () => {
    const { tokens } = await issued();
    await expect(verifyIdToken({ idToken: tokens.id_token!, clientId: PORTAL.clientId, nonce: "nonce-1" })).resolves.toBeTruthy();
    for (const other of [ADMIN, BUSINESS]) {
      await expect(verifyIdToken({ idToken: tokens.id_token!, clientId: other.clientId, nonce: "nonce-1" })).rejects.toMatchObject({ reason: "wrong_audience" });
    }
  });

  it("rejects wrong issuer, wrong nonce, missing nonce, expired, tampered, wrong key and unknown kid", async () => {
    const { tokens } = await issued();
    const idToken = tokens.id_token!;
    const ok = { idToken, clientId: PORTAL.clientId, nonce: "nonce-1" };
    await expect(verifyIdToken({ ...ok, issuer: "https://evil.example/api" })).rejects.toMatchObject({ reason: "wrong_issuer" });
    await expect(verifyIdToken({ ...ok, nonce: "other" })).rejects.toMatchObject({ reason: "nonce_mismatch" });
    await expect(verifyIdToken({ ...ok, nonce: null })).rejects.toMatchObject({ reason: "nonce_mismatch" });
    await expect(verifyIdToken({ ...ok, now: new Date(Date.now() + 10 * 60_000) })).rejects.toMatchObject({ reason: "expired" });

    const [h, p, s] = idToken.split(".");
    const forged = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
    forged.sub = "TD-SOMEONEELSE";
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`;
    await expect(verifyIdToken({ ...ok, idToken: tampered })).rejects.toBeInstanceOf(IdTokenError);

    const realKid = jose.decodeProtectedHeader(idToken).kid!;
    const { privateKey } = await jose.generateKeyPair("EdDSA");
    const sign = (kid: string) =>
      new jose.SignJWT({ azp: PORTAL.clientId, nonce: "nonce-1" })
        .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
        .setIssuer(config.oidcIssuer)
        .setSubject("TD-X")
        .setAudience(PORTAL.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    await expect(verifyIdToken({ ...ok, idToken: await sign(realKid) })).rejects.toMatchObject({ reason: "invalid_signature" });
    await expect(verifyIdToken({ ...ok, idToken: await sign("unknown-kid") })).rejects.toBeInstanceOf(IdTokenError);
  });

  it("an id_token is not an access token: userinfo and step-up refuse it", async () => {
    const { tokens } = await issued();
    const asBearer = { authorization: `Bearer ${tokens.id_token}` };
    const userinfo = await app.inject({ method: "GET", url: "/oauth/userinfo", headers: asBearer });
    expect(userinfo.statusCode).toBe(401);
    const stepUp = await app.inject({ method: "POST", url: "/v1/step-up/challenges", headers: asBearer, payload: {} });
    expect(stepUp.statusCode).toBe(401);
    expect(stepUp.json()).toMatchObject({ error: "invalid_token" });
    const real = await app.inject({ method: "GET", url: "/oauth/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(real.statusCode).toBe(200);
  });

  it("Portal clients always receive openid (added by TrustID), so every code exchange returns an id_token", async () => {
    const { user } = await portalUser();
    const tokens = await portalTokens(app, user.id, { scopes: [SCOPES.IDENTITY_BASIC] });
    expect(tokens.scope.split(" ")).toContain(SCOPES.OPENID);
    expect(tokens.id_token).toBeTruthy();
  });

  it("discovery advertises only what is implemented", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    const d = res.json() as Record<string, unknown>;
    expect(d).toMatchObject({
      issuer: config.oidcIssuer,
      jwks_uri: `${config.oidcIssuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["EdDSA"],
      subject_types_supported: ["public"],
    });
    expect(d.scopes_supported).toContain("identity.step_up");
    const jwks = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect((jwks.json() as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
  });
});
