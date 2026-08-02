import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../..");
const testDbPath = path.join(apiRoot, "prisma", "test.db");

/**
 * Uses a dedicated SQLite file. Deletes the file then pushes schema —
 * no --force-reset (avoid destructive migrate flags in CI/agent contexts).
 */
export function setupTestDatabase() {
  process.env.DATABASE_URL = `file:${testDbPath}`;
  process.env.NODE_ENV = "test";
  process.env.COOKIE_SECRET = "test-cookie-secret";
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.WEBAUTHN_RP_NAME = "TrustID";
  process.env.WEBAUTHN_ORIGIN = "http://localhost:5173";

  for (const p of [testDbPath, `${testDbPath}-journal`, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  execSync("npx prisma db push --skip-generate", {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${testDbPath}` },
    stdio: "pipe",
  });
}

export async function resetTables(prisma: PrismaClient) {
  await prisma.auditEvent.deleteMany();
  await prisma.webAuthnChallenge.deleteMany();
  await prisma.credential.deleteMany();
  await prisma.device.deleteMany();
  await prisma.session.deleteMany();
  await prisma.identityVerification.deleteMany();
  await prisma.verificationChallenge.deleteMany();
  await prisma.recoveryMethod.deleteMany();
  await prisma.contactMethod.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();
}
