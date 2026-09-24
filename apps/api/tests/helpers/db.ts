import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trustid-api-test-"));
const testDbPath = path.join(testRoot, "test.db").replaceAll("\\", "/");

/**
 * Uses a dedicated SQLite file. Deletes the file then pushes schema —
 * no --force-reset (avoid destructive migrate flags in CI/agent contexts).
 */
export function setupTestDatabase() {
  // Windows schema engine expects the freshly allocated SQLite file to exist.
  fs.writeFileSync(testDbPath, "", { flag: "wx" });
  process.env.DATABASE_URL = `file:${testDbPath}`;
  process.env.NODE_ENV = "test";
  process.env.COOKIE_SECRET = "test-cookie-secret";
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.WEBAUTHN_RP_NAME = "TrustID";
  process.env.WEBAUTHN_ORIGIN = "http://localhost:5173";
  process.env.IDENTITY_VERIFICATION_MODE = "mock";
  process.env.ASSERTION_ISSUER = "http://localhost:5173";
  process.env.TRUSTID_MEDIA_ROOT = path.join(testRoot, "media");

  const repoRoot = path.resolve(apiRoot, "../..");
  const schema = fs.readFileSync(path.join(apiRoot, "prisma/schema.prisma"), "utf8")
    .replace(/(datasource db\s*\{\s*provider\s*=\s*)"[^"]+"/, '$1"sqlite"');
  const isolatedSchema = path.join(testRoot, "schema.prisma");
  fs.writeFileSync(isolatedSchema, schema);
  execFileSync(process.execPath, [path.join(repoRoot, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", isolatedSchema], {
    cwd: testRoot,
    env: { ...process.env, DATABASE_URL: `file:${testDbPath}` },
    stdio: "pipe",
  });
}

export async function resetTables(prisma: PrismaClient) {
  await prisma.auditEvent.deleteMany();
  await prisma.securityNotification.deleteMany();
  await prisma.assertionJti.deleteMany();
  await prisma.assertionSigningKey.deleteMany();
  await prisma.impersonationReport.deleteMany();
  await prisma.identityVerification.deleteMany();
  await prisma.verifiedIdentityProfile.deleteMany();
  await prisma.identityPortrait.deleteMany();
  await prisma.identityMediaObject.deleteMany();
  await prisma.webAuthnChallenge.deleteMany();
  await prisma.oAuthAccessToken.deleteMany();
  await prisma.oAuthRefreshToken.deleteMany();
  await prisma.oAuthAuthorizationCode.deleteMany();
  await prisma.authorizationScope.deleteMany();
  await prisma.authorization.deleteMany();
  await prisma.session.deleteMany();
  await prisma.credential.deleteMany();
  await prisma.silentDeviceKey.deleteMany();
  await prisma.deviceApprovalRequest.deleteMany();
  await prisma.bbsStepUpChallenge.deleteMany();
  await prisma.biometricEmbedding.deleteMany();
  await prisma.biometricTemplate.deleteMany();
  await prisma.masterAuthChallenge.deleteMany();
  await prisma.masterDevice.deleteMany();
  await prisma.devicePushToken.deleteMany();
  await prisma.devicePairingRequest.deleteMany();
  await prisma.deviceInstall.deleteMany();
  await prisma.device.deleteMany();
  await prisma.accountPreferences.deleteMany();
  await prisma.verificationChallenge.deleteMany();
  await prisma.recoveryMethod.deleteMany();
  await prisma.contactMethod.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.application.deleteMany();
  await prisma.user.deleteMany();
}
