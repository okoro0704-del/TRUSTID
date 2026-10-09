import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { createSession } from "../src/modules/sessions/service.js";
import { createAuthorizationTransaction, issueAuthorizationCodeFromTransaction } from "../src/modules/authorization/transaction-store.js";
import { bootstrapPortalClients } from "../src/lib/bootstrap-oauth-apps.js";
import { PORTAL, pkcePair } from "./helpers/portal-oauth.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import { resetTables } from "./helpers/db.js";

async function bound() {
  const user = await createZeroPiiUser(`s3-${crypto.randomUUID()}@example.test`);
  const { session } = await createSession({ userId: user.id });
  const app = await prisma.application.findUniqueOrThrow({ where: { clientId: PORTAL.clientId } });
  const { challenge } = pkcePair();
  const binding = `binding-${crypto.randomUUID()}`;
  const created = await createAuthorizationTransaction({ applicationId: app.id, redirectUri: PORTAL.redirectUris[0]!, scopes: ["openid", "identity.basic"], state: "original-state", codeChallenge: challenge, nonce: "original-nonce", preAuthBinding: binding });
  await prisma.oAuthAuthorizationTransaction.update({ where: { id: created.row.id }, data: { userId: user.id, sessionId: session.id } });
  return { user, session, binding, ...created };
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
});
