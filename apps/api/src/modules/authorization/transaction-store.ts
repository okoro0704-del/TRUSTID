import { prisma } from "../../db/client.js";
import { hashSecret, randomToken } from "../../lib/crypto.js";
import type { Prisma } from "@prisma/client";

const TTL_MS = 10 * 60 * 1000;
type Db = typeof prisma | Prisma.TransactionClient;
const pending = () => ({ status: "pending", expiresAt: { gt: new Date() } });

export type AuthorizationTransactionInput = {
  applicationId: string; redirectUri: string; scopes: string[]; state?: string | null;
  codeChallenge: string; nonce?: string | null; preAuthBinding: string;
};

export async function createAuthorizationTransaction(input: AuthorizationTransactionInput, db: Db = prisma) {
  const handle = randomToken(32);
  const row = await db.oAuthAuthorizationTransaction.create({ data: {
    handleHash: hashSecret(handle), preAuthBindingHash: hashSecret(input.preAuthBinding),
    applicationId: input.applicationId, redirectUri: input.redirectUri, scopes: JSON.stringify(input.scopes),
    state: input.state ?? null, codeChallenge: input.codeChallenge, codeChallengeMethod: "S256", nonce: input.nonce ?? null,
    expiresAt: new Date(Date.now() + TTL_MS),
  } });
  return { handle, row };
}

export async function getAuthorizationTransaction(handle: string, db: Db = prisma) {
  const row = await db.oAuthAuthorizationTransaction.findFirst({ where: { handleHash: hashSecret(handle), ...pending() } });
  if (!row) throw Object.assign(new Error("invalid_authorization_transaction"), { statusCode: 400 });
  return row;
}

/** Read a pending transaction only for the browser that received its opaque handle. */
export async function getAuthorizationTransactionForBrowser(handle: string, preAuthBinding: string, db: Db = prisma) {
  const row = await getAuthorizationTransaction(handle, db);
  if (row.preAuthBindingHash !== hashSecret(preAuthBinding)) {
    throw Object.assign(new Error("invalid_authorization_transaction"), { statusCode: 400 });
  }
  return row;
}

export async function bindAuthorizationTransaction(handle: string, preAuthBinding: string, userId: string, sessionId: string, db: Db = prisma) {
  const updated = await db.oAuthAuthorizationTransaction.updateMany({ where: {
    handleHash: hashSecret(handle), preAuthBindingHash: hashSecret(preAuthBinding), userId: null, sessionId: null, ...pending(),
  }, data: { userId, sessionId } });
  if (updated.count !== 1) throw Object.assign(new Error("invalid_authorization_transaction"), { statusCode: 400 });
  return getAuthorizationTransaction(handle, db);
}

export async function denyAuthorizationTransaction(handle: string, sessionId: string, db: Db = prisma) {
  const updated = await db.oAuthAuthorizationTransaction.updateMany({ where: { handleHash: hashSecret(handle), sessionId, ...pending() }, data: { status: "denied", deniedAt: new Date() } });
  return updated.count === 1;
}

/** Atomically reserves a bound transaction; S3 performs code creation in the same DB transaction. */
export async function claimAuthorizationTransaction(handle: string, sessionId: string, db: Db = prisma) {
  const updated = await db.oAuthAuthorizationTransaction.updateMany({ where: { handleHash: hashSecret(handle), sessionId, ...pending() }, data: { status: "consumed", consumedAt: new Date() } });
  return updated.count === 1;
}
