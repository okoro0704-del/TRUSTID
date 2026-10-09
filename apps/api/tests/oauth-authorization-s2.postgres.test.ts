import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { bootstrapPortalClients } from "../src/lib/bootstrap-oauth-apps.js";
import { resetTables } from "./helpers/db.js";
import { PORTAL, pkcePair, portalUser } from "./helpers/portal-oauth.js";

process.env.OAUTH_TRANSACTION_INTEGRATION = "true";

const bindingCookie = "trustid_oauth_binding";
const csrfCookie = "trustid_oauth_csrf";
let app: Awaited<ReturnType<typeof buildApp>>;

function cookies(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(lines.map((line) => {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    return [pair.slice(0, i), decodeURIComponent(pair.slice(i + 1))];
  }));
}

async function start(overrides: Record<string, string> = {}) {
  const { challenge } = pkcePair();
  const response = await app.inject({
    method: "GET",
    url: "/oauth/authorize",
    query: {
      client_id: PORTAL.clientId,
      redirect_uri: PORTAL.redirectUris[0]!,
      response_type: "code",
      scope: "openid identity.basic",
      state: "s2-state",
      nonce: "s2-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...overrides,
    },
  });
  return { response, challenge, cookies: cookies(response) };
}

describe.runIf(Boolean(process.env.TRUSTID_TEST_POSTGRES_URL))("S2 server-bound OAuth authorization and consent", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    await bootstrapPortalClients(() => undefined);
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    delete process.env.OAUTH_TRANSACTION_INTEGRATION;
  });

  it("stores validated authority server-side and exposes only an opaque transaction reference", async () => {
    const { response, challenge, cookies: jar } = await start();
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect([...location.searchParams.keys()]).toEqual(["transaction"]);
    const handle = location.searchParams.get("transaction")!;
    expect(handle).toHaveLength(43);
    const row = await prisma.oAuthAuthorizationTransaction.findFirstOrThrow();
    expect(row.handleHash).not.toContain(handle);
    expect(row.redirectUri).toBe(PORTAL.redirectUris[0]);
    expect(row.codeChallenge).toBe(challenge);
    expect(row.nonce).toBe("s2-nonce");
    expect(JSON.parse(row.scopes)).toEqual(expect.arrayContaining(["openid", "identity.basic"]));
    expect(jar[bindingCookie]).toBeTruthy();
    expect(jar[csrfCookie]).toBeTruthy();
  });

  it("rejects invalid client, URI, scope and PKCE downgrade before creating a transaction", async () => {
    for (const overrides of [
      { client_id: "missing" },
      { redirect_uri: "https://evil.example/callback" },
      { scope: "openid elevated" },
      { code_challenge_method: "plain" },
    ]) {
      const { response } = await start(overrides);
      expect(response.statusCode).toBe(400);
    }
    expect(await prisma.oAuthAuthorizationTransaction.count()).toBe(0);
  });

  it("binds the initiating browser to the authenticated session and rejects substitution", async () => {
    const { user, sessionToken } = await portalUser();
    const { response, cookies: jar } = await start();
    const transaction = new URL(response.headers.location as string).searchParams.get("transaction")!;
    const headers = { "x-trustid-session": sessionToken };
    const resume = await app.inject({ method: "POST", url: "/oauth/consent/resume", headers, cookies: { [bindingCookie]: jar[bindingCookie]! }, payload: { transaction } });
    expect(resume.statusCode).toBe(200);
    const row = await prisma.oAuthAuthorizationTransaction.findFirstOrThrow();
    expect(row.userId).toBe(user.id);
    await expect(app.inject({ method: "POST", url: "/oauth/consent/resume", headers, payload: { transaction } })).resolves.toMatchObject({ statusCode: 400 });
    const other = await portalUser();
    const crossSession = await app.inject({ method: "POST", url: "/oauth/consent", headers: { "x-trustid-session": other.sessionToken, "x-trustid-oauth-csrf": jar[csrfCookie]! }, cookies: { [bindingCookie]: jar[bindingCookie]!, [csrfCookie]: jar[csrfCookie]! }, payload: { transaction, approve: false } });
    expect(crossSession.statusCode).toBe(400);
  });

  it("rejects consent CSRF, issues once after S3, and preserves denial semantics", async () => {
    const { sessionToken } = await portalUser();
    const { response, cookies: jar } = await start();
    const transaction = new URL(response.headers.location as string).searchParams.get("transaction")!;
    const headers = { "x-trustid-session": sessionToken };
    await app.inject({ method: "POST", url: "/oauth/consent/resume", headers, cookies: { [bindingCookie]: jar[bindingCookie]! }, payload: { transaction } });
    const csrf = await app.inject({ method: "POST", url: "/oauth/consent", headers, cookies: { [bindingCookie]: jar[bindingCookie]!, [csrfCookie]: jar[csrfCookie]! }, payload: { transaction, approve: true } });
    expect(csrf.statusCode).toBe(403);
    const approved = await app.inject({ method: "POST", url: "/oauth/consent", headers: { ...headers, "x-trustid-oauth-csrf": jar[csrfCookie]! }, cookies: { [bindingCookie]: jar[bindingCookie]!, [csrfCookie]: jar[csrfCookie]! }, payload: { transaction, approve: true } });
    expect(approved.statusCode).toBe(200);
    expect(new URL(approved.json().redirectTo).searchParams.get("code")).toBeTruthy();
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);

    const denied = await start();
    const deniedHandle = new URL(denied.response.headers.location as string).searchParams.get("transaction")!;
    await app.inject({ method: "POST", url: "/oauth/consent/resume", headers, cookies: { [bindingCookie]: denied.cookies[bindingCookie]! }, payload: { transaction: deniedHandle } });
    const deniedResponse = await app.inject({ method: "POST", url: "/oauth/consent", headers: { ...headers, "x-trustid-oauth-csrf": denied.cookies[csrfCookie]! }, cookies: { [bindingCookie]: denied.cookies[bindingCookie]!, [csrfCookie]: denied.cookies[csrfCookie]! }, payload: { transaction: deniedHandle, approve: false } });
    expect(deniedResponse.statusCode).toBe(200);
    expect(new URL(deniedResponse.json().redirectTo).searchParams.get("error")).toBe("access_denied");
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
  });

  it("keeps the established OAuth behavior when the integration boundary is disabled", async () => {
    process.env.OAUTH_TRANSACTION_INTEGRATION = "false";
    const { sessionToken } = await portalUser();
    const { response } = await start();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/oauth/consent?");
    expect(await prisma.oAuthAuthorizationTransaction.count()).toBe(0);
    process.env.OAUTH_TRANSACTION_INTEGRATION = "true";
    void config;
  });
});
