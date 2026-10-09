import { afterAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { createSession } from "../src/modules/sessions/service.js";
import { createAuthorizationTransaction, issueAuthorizationCodeFromTransaction } from "../src/modules/authorization/transaction-store.js";
import { exchangeAuthorizationCode } from "../src/modules/authorization/service.js";
import { verifyIdToken } from "../src/modules/authorization/id-token.js";
import { bootstrapPortalClients } from "../src/lib/bootstrap-oauth-apps.js";
import { PORTAL, pkcePair } from "./helpers/portal-oauth.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import { resetTables } from "./helpers/db.js";

process.env.OAUTH_TRANSACTION_INTEGRATION = "true";

async function bound() {
  const user = await createZeroPiiUser(`s3-${crypto.randomUUID()}@example.test`);
  const { session, token: sessionToken } = await createSession({ userId: user.id });
  const app = await prisma.application.findUniqueOrThrow({ where: { clientId: PORTAL.clientId } });
  const { verifier, challenge } = pkcePair();
  const binding = `binding-${crypto.randomUUID()}`;
  const created = await createAuthorizationTransaction({ applicationId: app.id, redirectUri: PORTAL.redirectUris[0]!, scopes: ["openid", "identity.basic"], state: "original-state", codeChallenge: challenge, nonce: "original-nonce", preAuthBinding: binding });
  await prisma.oAuthAuthorizationTransaction.update({ where: { id: created.row.id }, data: { userId: user.id, sessionId: session.id } });
  return { user, session, sessionToken, binding, verifier, ...created };
}

describe.runIf(Boolean(process.env.TRUSTID_TEST_POSTGRES_URL))("S3 atomic authorization-code issuance", () => {
  beforeEach(async () => { await resetTables(prisma); await bootstrapPortalClients(() => undefined); });
  afterAll(async () => prisma.$disconnect());

  it("commits one linked code and consumed transaction together", async () => {
    const f = await bound();
    const issued = await issueAuthorizationCodeFromTransaction({ handle: f.handle, preAuthBinding: f.binding, userId: f.user.id, sessionId: f.session.id, authTime: f.session.createdAt });
    const row = await prisma.oAuthAuthorizationTransaction.findUniqueOrThrow({ where: { id: f.row.id }, include: { authorizationCode: true } });
    expect(row.status).toBe("consumed");
    expect(row.authorizationCode?.codeHash).toBeTruthy();
    expect(issued.code).not.toEqual(row.authorizationCode?.codeHash);
    expect(row.authorizationCode).toMatchObject({ redirectUri: PORTAL.redirectUris[0], nonce: "original-nonce", codeChallenge: row.codeChallenge });
  });

  it("allows exactly one concurrent issuer and rolls no partial state from a rejected repeat", async () => {
    const f = await bound();
    const input = { handle: f.handle, preAuthBinding: f.binding, userId: f.user.id, sessionId: f.session.id };
    const results = await Promise.allSettled([issueAuthorizationCodeFromTransaction(input), issueAuthorizationCodeFromTransaction(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
    await expect(issueAuthorizationCodeFromTransaction(input)).rejects.toThrow("invalid_authorization_transaction");
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
  });

  it("issues exactly once through independent Prisma connection pools", async () => {
    const f = await bound();
    const input = { handle: f.handle, preAuthBinding: f.binding, userId: f.user.id, sessionId: f.session.id };
    const first = new PrismaClient(); const second = new PrismaClient();
    try {
      const results = await Promise.allSettled([issueAuthorizationCodeFromTransaction(input, first), issueAuthorizationCodeFromTransaction(input, second)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const row = await prisma.oAuthAuthorizationTransaction.findUniqueOrThrow({ where: { id: f.row.id } });
      expect(row.authorizationCodeId).toBeTruthy();
      expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
    } finally { await Promise.all([first.$disconnect(), second.$disconnect()]); }
  });

  it("rolls back the actual conditional claim when PostgreSQL rejects code persistence", async () => {
    const f = await bound();
    const input = { handle: f.handle, preAuthBinding: f.binding, userId: f.user.id, sessionId: f.session.id };
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_s3_code_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced s3 code failure'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_s3_code_insert_trigger BEFORE INSERT ON oauth_authorization_codes FOR EACH ROW EXECUTE FUNCTION fail_s3_code_insert()`);
    await expect(issueAuthorizationCodeFromTransaction(input)).rejects.toThrow();
    const rolledBack = await prisma.oAuthAuthorizationTransaction.findUniqueOrThrow({ where: { id: f.row.id } });
    expect(rolledBack.status).toBe("pending");
    expect(rolledBack.authorizationCodeId).toBeNull();
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(0);
    await prisma.$executeRawUnsafe(`DROP TRIGGER fail_s3_code_insert_trigger ON oauth_authorization_codes`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION fail_s3_code_insert()`);
    await expect(issueAuthorizationCodeFromTransaction(input)).resolves.toMatchObject({ code: expect.any(String) });
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
  });

  it("exchanges the issued code with the original PKCE challenge and preserves the original nonce", async () => {
    const f = await bound();
    const issued = await issueAuthorizationCodeFromTransaction({ handle: f.handle, preAuthBinding: f.binding, userId: f.user.id, sessionId: f.session.id, authTime: f.session.createdAt });
    const tokens = await exchangeAuthorizationCode({ code: issued.code, clientId: PORTAL.clientId, redirectUri: PORTAL.redirectUris[0]!, codeVerifier: f.verifier });
    const claims = await verifyIdToken({ idToken: tokens.id_token!, clientId: PORTAL.clientId, nonce: "original-nonce" });
    expect(claims.sub).toBe(f.user.trustId);
    const app = await buildApp();
    try {
      const userinfo = await app.inject({ method: "GET", url: "/oauth/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` } });
      expect(userinfo.json().sub).toBe(claims.sub);
      expect(userinfo.json().sub).not.toBe("TD-SUBJECT-MISMATCH");
    } finally { await app.close(); }
    await expect(exchangeAuthorizationCode({ code: issued.code, clientId: PORTAL.clientId, redirectUri: PORTAL.redirectUris[0]!, codeVerifier: f.verifier })).rejects.toThrow("invalid_grant");
  });

  it("refuses expired and denied transactions on the actual S3 issuance service", async () => {
    const expired = await bound();
    await prisma.oAuthAuthorizationTransaction.update({ where: { id: expired.row.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(issueAuthorizationCodeFromTransaction({ handle: expired.handle, preAuthBinding: expired.binding, userId: expired.user.id, sessionId: expired.session.id })).rejects.toThrow("invalid_authorization_transaction");
    const denied = await bound();
    await prisma.oAuthAuthorizationTransaction.update({ where: { id: denied.row.id }, data: { status: "denied", deniedAt: new Date() } });
    await expect(issueAuthorizationCodeFromTransaction({ handle: denied.handle, preAuthBinding: denied.binding, userId: denied.user.id, sessionId: denied.session.id })).rejects.toThrow("invalid_authorization_transaction");
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(0);
  });

  it("does not reissue after a real post-commit HTTP transport interruption", async () => {
    const f = await bound();
    let destroyOnce = true;
    const app = await buildApp();
    app.addHook("onSend", async (request, reply, payload) => {
      if (destroyOnce && request.url === "/oauth/consent") {
        destroyOnce = false;
        reply.raw.destroy();
      }
      return payload;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const body = JSON.stringify({ transaction: f.handle, approve: true });
    try {
      await new Promise<void>((resolve) => {
        const req = http.request(`${address}/oauth/consent`, {
          method: "POST",
          headers: {
            "content-type": "application/json", "content-length": Buffer.byteLength(body),
            "x-trustid-session": f.sessionToken,
            "x-trustid-oauth-csrf": "csrf-proof",
            cookie: `trustid_oauth_binding=${encodeURIComponent(f.binding)}; trustid_oauth_csrf=csrf-proof`,
          },
        });
        req.on("error", () => resolve()); req.on("close", () => resolve()); req.end(body);
      });
      const row = await prisma.oAuthAuthorizationTransaction.findUniqueOrThrow({ where: { id: f.row.id } });
      expect(row.status).toBe("consumed");
      expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
      await expect(issueAuthorizationCodeFromTransaction({ handle: f.handle, preAuthBinding: f.binding, userId: f.user.id, sessionId: f.session.id })).rejects.toThrow("invalid_authorization_transaction");
      expect(await prisma.oAuthAuthorizationCode.count()).toBe(1);
    } finally { await app.close(); }
  });
});
