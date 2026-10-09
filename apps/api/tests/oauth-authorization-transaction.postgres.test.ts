import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/db/client.js";
import { hashSecret } from "../src/lib/crypto.js";
import {
  bindAuthorizationTransaction,
  claimAuthorizationTransaction,
  createAuthorizationTransaction,
  denyAuthorizationTransaction,
  getAuthorizationTransaction,
} from "../src/modules/authorization/transaction-store.js";
import { resetTables } from "./helpers/db.js";

const expiry = () => new Date(Date.now() + 60 * 60 * 1000);

async function fixture() {
  const user = await prisma.user.create({ data: { trustId: `did:trustid:s1:${crypto.randomUUID()}` } });
  const application = await prisma.application.create({
    data: {
      clientId: `s1-client-${crypto.randomUUID()}`,
      name: "S1 persistence test client",
      type: "public",
      redirectUris: JSON.stringify(["http://localhost/s1-callback"]),
      allowedScopes: JSON.stringify(["openid"]),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, tokenHash: hashSecret(`session-${crypto.randomUUID()}`), expiresAt: expiry() },
  });
  const alternateSession = await prisma.session.create({
    data: { userId: user.id, tokenHash: hashSecret(`alternate-${crypto.randomUUID()}`), expiresAt: expiry() },
  });
  const created = await createAuthorizationTransaction({
    applicationId: application.id,
    redirectUri: "http://localhost/s1-callback",
    scopes: ["openid", "profile"],
    state: "state-is-immutable",
    codeChallenge: "challenge-is-immutable",
    nonce: "nonce-is-immutable",
    preAuthBinding: "pre-auth-binding",
  });
  return { user, application, session, alternateSession, ...created };
}

describe.runIf(Boolean(process.env.TRUSTID_TEST_POSTGRES_URL))("OAuth authorization transaction PostgreSQL persistence", () => {
  beforeEach(async () => resetTables(prisma));
  afterAll(async () => prisma.$disconnect());

  it("creates, retrieves, and stores only a hash of the opaque handle", async () => {
    const { application, handle, row } = await fixture();
    const stored = await prisma.oAuthAuthorizationTransaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.handleHash).toBe(hashSecret(handle));
    expect(stored.handleHash).not.toContain(handle);
    expect(stored.applicationId).toBe(application.id);
    expect(stored.redirectUri).toBe("http://localhost/s1-callback");
    expect(stored.scopes).toBe(JSON.stringify(["openid", "profile"]));
    expect(stored.state).toBe("state-is-immutable");
    expect(stored.codeChallenge).toBe("challenge-is-immutable");
    expect(stored.nonce).toBe("nonce-is-immutable");
    await expect(getAuthorizationTransaction(handle)).resolves.toMatchObject({ id: row.id, status: "pending" });
    await expect(getAuthorizationTransaction("nonexistent")).rejects.toThrow("invalid_authorization_transaction");
  });

  it("rejects expired and denied transactions at operation time", async () => {
    const { handle, row, session } = await fixture();
    await prisma.oAuthAuthorizationTransaction.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(getAuthorizationTransaction(handle)).rejects.toThrow("invalid_authorization_transaction");
    await expect(bindAuthorizationTransaction(handle, "pre-auth-binding", "missing", session.id)).rejects.toThrow("invalid_authorization_transaction");

    const active = await fixture();
    await bindAuthorizationTransaction(active.handle, "pre-auth-binding", active.user.id, active.session.id);
    await expect(denyAuthorizationTransaction(active.handle, active.session.id)).resolves.toBe(true);
    await expect(getAuthorizationTransaction(active.handle)).rejects.toThrow("invalid_authorization_transaction");
    await expect(claimAuthorizationTransaction(active.handle, active.session.id)).resolves.toBe(false);
  });

  it("binds one matching session once and rejects a wrong-session claim", async () => {
    const { handle, user, session, alternateSession } = await fixture();
    await expect(bindAuthorizationTransaction(handle, "wrong-binding", user.id, session.id)).rejects.toThrow("invalid_authorization_transaction");
    await expect(bindAuthorizationTransaction(handle, "pre-auth-binding", user.id, session.id)).resolves.toMatchObject({ userId: user.id, sessionId: session.id });
    await expect(bindAuthorizationTransaction(handle, "pre-auth-binding", user.id, alternateSession.id)).rejects.toThrow("invalid_authorization_transaction");
    await expect(claimAuthorizationTransaction(handle, alternateSession.id)).resolves.toBe(false);
  });

  it("enforces one-time claim under concurrent calls and separate clients", async () => {
    const concurrent = await fixture();
    await bindAuthorizationTransaction(concurrent.handle, "pre-auth-binding", concurrent.user.id, concurrent.session.id);
    const sameClient = await Promise.all([
      claimAuthorizationTransaction(concurrent.handle, concurrent.session.id),
      claimAuthorizationTransaction(concurrent.handle, concurrent.session.id),
    ]);
    expect(sameClient.filter(Boolean)).toHaveLength(1);
    await expect(claimAuthorizationTransaction(concurrent.handle, concurrent.session.id)).resolves.toBe(false);

    const separate = await fixture();
    await bindAuthorizationTransaction(separate.handle, "pre-auth-binding", separate.user.id, separate.session.id);
    const first = new PrismaClient();
    const second = new PrismaClient();
    try {
      const results = await Promise.all([
        claimAuthorizationTransaction(separate.handle, separate.session.id, first),
        claimAuthorizationTransaction(separate.handle, separate.session.id, second),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  });

  it("survives a new Prisma client and rolls a claim back with its outer transaction", async () => {
    const persisted = await fixture();
    const restarted = new PrismaClient();
    try {
      await expect(getAuthorizationTransaction(persisted.handle, restarted)).resolves.toMatchObject({ id: persisted.row.id });
    } finally {
      await restarted.$disconnect();
    }

    await bindAuthorizationTransaction(persisted.handle, "pre-auth-binding", persisted.user.id, persisted.session.id);
    await expect(prisma.$transaction(async (tx) => {
      expect(await claimAuthorizationTransaction(persisted.handle, persisted.session.id, tx)).toBe(true);
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    await expect(claimAuthorizationTransaction(persisted.handle, persisted.session.id)).resolves.toBe(true);
  });
});
