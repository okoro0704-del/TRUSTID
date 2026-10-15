/**
 * Staging / production trust boundaries, tested through real application start-up (buildApp), the
 * real WebAuthn verifier, the real OAuth bootstrap and the real seed script.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CANONICAL_LIFEOS_WEB_ORIGIN, config } from "../src/lib/config.js";
import { DeploymentConfigError } from "../src/lib/deployment.js";
import { PORTAL_OAUTH_CLIENTS, portalOAuthClients } from "../src/lib/portal-oauth-clients.js";
import { enrollmentConfig } from "../src/modules/step-up/master-device-enrollment.js";
import { verifyReauthentication } from "../src/modules/authentication/webauthn.js";
import { createSession } from "../src/modules/sessions/service.js";
import { resetTables } from "./helpers/db.js";
import { assertion, seedPasskey } from "./helpers/android-attestation.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";

const STAGING_HOST = "trustid-staging.example.app";
const STAGING = `https://${STAGING_HOST}`;
const STAGING_PORTAL = "https://portal-staging.example.app";
const STAGING_CERT = "5a".repeat(32); // non-secret test fixture, not a real certificate
const DEBUG_CERT = "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa";
const secret = () => randomBytes(36).toString("base64url");

/** Every variable these tests touch, cleared first so the ambient test env cannot leak in. */
const CLEARED = [
  "TRUSTID_DEPLOY_ENV", "WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN", "WEBAUTHN_ORIGINS", "CORS_ORIGINS", "OIDC_ISSUER", "ASSERTION_ISSUER",
  "TRUSTID_STAGING_PORTAL_ORIGIN", "TRUSTID_STAGING_ADMIN_ORIGIN", "TRUSTID_STAGING_BUSINESS_ORIGIN",
  "MASTER_DEVICE_ENROLLMENT", "MASTER_DEVICE_ATTESTATION", "ANDROID_APP_PACKAGE", "ANDROID_APP_SIGNING_SHA256", "WEBAUTHN_ANDROID_ORIGINS",
  "OTP_EXPOSE_DEBUG", "EXPOSE_SESSION_TOKEN_IN_BODY", "ALLOW_LEGACY_PII_SCOPES", "LIFEOS_AUTH_BYPASS",
  "ELFCOM_MODE", "DATAZONE_MODE", "LIDIOS_MODE", "DIGICONOMY_MODE", "PLATFORM_JOB_MODE", "MASTER_DISTRIBUTION_MODE", "FINPROV_MODE",
  "URL", "DEPLOY_PRIME_URL", "DEPLOY_URL",
];

function stub(vars: Record<string, string>) {
  for (const name of CLEARED) vi.stubEnv(name, "");
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

const runtimeSecrets = () => ({ COOKIE_SECRET: secret(), SESSION_SECRET: secret(), PII_PEPPER: secret(), SEAL_KEY: secret() });

const stagingEnv = (over: Record<string, string> = {}) => ({
  NODE_ENV: "production",
  TRUSTID_DEPLOY_ENV: "staging",
  ...runtimeSecrets(),
  WEBAUTHN_RP_ID: STAGING_HOST,
  WEBAUTHN_ORIGIN: STAGING,
  CORS_ORIGINS: `${STAGING},${STAGING_PORTAL}`,
  OIDC_ISSUER: `${STAGING}/api`,
  TRUSTID_STAGING_PORTAL_ORIGIN: STAGING_PORTAL,
  MASTER_DEVICE_ENROLLMENT: "enabled",
  ANDROID_APP_PACKAGE: "com.trustid.device.staging",
  ANDROID_APP_SIGNING_SHA256: STAGING_CERT,
  WEBAUTHN_ANDROID_ORIGINS: `android:apk-key-hash:${Buffer.from(STAGING_CERT, "hex").toString("base64url")}`,
  ...over,
});

const productionEnv = (over: Record<string, string> = {}) => ({
  NODE_ENV: "production",
  ...runtimeSecrets(),
  WEBAUTHN_RP_ID: "trustedid.netlify.app",
  WEBAUTHN_ORIGIN: "https://trustedid.netlify.app",
  CORS_ORIGINS: `https://trustedid.netlify.app,${CANONICAL_LIFEOS_WEB_ORIGIN}`,
  OIDC_ISSUER: "https://trustedid.netlify.app/api",
  ...over,
});

/** Start the real app under `vars`; returns it (closed after the test) or the start-up error. */
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
async function start(vars: Record<string, string>) {
  stub(vars);
  const app = await buildApp();
  apps.push(app);
  return app;
}
async function startError(vars: Record<string, string>): Promise<Error> {
  stub(vars);
  try {
    apps.push(await buildApp());
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected start-up to fail");
}

beforeEach(async () => {
  await resetTables(prisma);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("staging start-up under NODE_ENV=production", () => {
  it("1/2. starts securely with production runtime settings and no production LifeOS origin", async () => {
    const app = await start(stagingEnv());
    expect(config.isDev).toBe(false);
    expect(config.webauthn.rpID).toBe(STAGING_HOST);
    expect(config.webauthn.origins).toEqual([STAGING]);
    expect(config.corsOrigins).not.toContain(CANONICAL_LIFEOS_WEB_ORIGIN);
    expect(config.corsOrigins.sort()).toEqual([STAGING, STAGING_PORTAL].sort());
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health.webauthn).toMatchObject({ rpID: STAGING_HOST, origins: [STAGING] });
    expect(JSON.stringify(health)).not.toMatch(/trustedid\.netlify\.app|getlifeos\.app/);
  });

  it("3. refuses production passkey origins, RP ID, CORS origins and issuer", async () => {
    for (const over of [
      { WEBAUTHN_ORIGINS: "https://trustedid.netlify.app" },
      { WEBAUTHN_RP_ID: "trustedid.netlify.app", WEBAUTHN_ORIGIN: "https://trustedid.netlify.app" },
      { CORS_ORIGINS: `${STAGING},${CANONICAL_LIFEOS_WEB_ORIGIN}` },
      { CORS_ORIGINS: `${STAGING},https://getlifeos.app` },
      { OIDC_ISSUER: "https://trustedid.netlify.app/api" },
      { TRUSTID_STAGING_PORTAL_ORIGIN: "https://getlifeos.app" },
    ]) {
      const err = await startError(stagingEnv(over));
      expect(err, JSON.stringify(over)).toBeInstanceOf(DeploymentConfigError);
      expect(err.message).toMatch(/production/);
    }
  });

  it("6. missing staging origin configuration fails closed", async () => {
    for (const name of ["WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN", "CORS_ORIGINS", "OIDC_ISSUER"]) {
      const err = await startError(stagingEnv({ [name]: "" }));
      expect(err.message, name).toMatch(new RegExp(`staging requires ${name}`));
    }
    const outside = await startError(stagingEnv({ WEBAUTHN_ORIGIN: "https://elsewhere.example.app" }));
    expect(outside.message).toMatch(/not within WEBAUTHN_RP_ID/);
    const plain = await startError(stagingEnv({ CORS_ORIGINS: `${STAGING},http://portal-staging.example.app` }));
    expect(plain.message).toMatch(/not an exact https origin/);
  });

  it("7. unknown deployment environments fail closed", async () => {
    expect((await startError(stagingEnv({ TRUSTID_DEPLOY_ENV: "qa" }))).message).toMatch(/must be "production" or "staging"/);
    expect((await startError(stagingEnv({ NODE_ENV: "development" }))).message).toMatch(/staging must run with NODE_ENV=production/);
    expect((await startError({ NODE_ENV: "test", TRUSTID_DEPLOY_ENV: "production" })).message).toMatch(/requires NODE_ENV=production/);
  });

  it("8. development secrets, debug flags, attestation bypass and production services stay unavailable", async () => {
    expect((await startError(stagingEnv({ COOKIE_SECRET: "dev-cookie-secret-change-in-production", SESSION_SECRET: "" }))).message).toMatch(/COOKIE_SECRET/);
    expect((await startError(stagingEnv({ SEAL_KEY: "" }))).message).toMatch(/SEAL_KEY/);
    expect((await startError(stagingEnv({ PII_PEPPER: "" }))).message).toMatch(/PII_PEPPER/);
    for (const flag of ["OTP_EXPOSE_DEBUG", "EXPOSE_SESSION_TOKEN_IN_BODY", "ALLOW_LEGACY_PII_SCOPES", "LIFEOS_AUTH_BYPASS"]) {
      expect((await startError(stagingEnv({ [flag]: "true" }))).message, flag).toMatch(new RegExp(`${flag} is not allowed`));
    }
    expect((await startError(stagingEnv({ MASTER_DEVICE_ATTESTATION: "off" }))).message).toMatch(/MASTER_DEVICE_ATTESTATION/);
    // DataZone's built-in default base URL is the production engine.
    expect((await startError(stagingEnv({ DATAZONE_MODE: "http" }))).message).toMatch(/DATAZONE_MODE=http points at https:\/\/sovereign-drive-engine-production/);
    expect((await startError(stagingEnv({ ELFCOM_MODE: "http", ELFCOM_BASE_URL: "" }))).message).toMatch(/ELFCOM_MODE=http points at/);
    expect((await startError(stagingEnv({ LIDIOS_MODE: "http", LIDIOS_BASE_URL: "https://token-network-production.up.railway.app" }))).message).toMatch(/LIDIOS_MODE=http points at/);
    // and even where the flag were tolerated, NODE_ENV=production keeps attestation on
    stub(stagingEnv({ MASTER_DEVICE_ATTESTATION: "off" }));
    expect(enrollmentConfig.attestation).toBe("android");
  });
});

describe("CORS permission does not imply passkey trust (real WebAuthn verification)", () => {
  it("4. an assertion from a CORS-only origin is refused; the same assertion from a passkey origin is accepted", async () => {
    stub({ CORS_ORIGINS: "https://cors-only.example.org" });
    const app = await buildApp();
    apps.push(app);
    expect(config.corsOrigins).toContain("https://cors-only.example.org");
    expect(config.webauthn.origins).not.toContain("https://cors-only.example.org");

    const user = await createZeroPiiUser(`${Math.random().toString(36).slice(2)}@example.test`);
    const { passkey, deviceId } = await seedPasskey(user.id);
    const { token } = await createSession({ userId: user.id, deviceId });
    const options = async () =>
      (await app.inject({ method: "POST", url: "/auth/webauthn/reauth/options", cookies: { [config.sessionCookieName]: token }, payload: {} })).json() as { challenge: string };
    const rpId = config.webauthn.rpID;

    const fromCors = assertion(passkey, { challenge: (await options()).challenge, rpId, origin: "https://cors-only.example.org" });
    await expect(verifyReauthentication({ userId: user.id, response: fromCors as never })).rejects.toMatchObject({ statusCode: 401 });

    const fromPasskeyOrigin = assertion(passkey, { challenge: (await options()).challenge, rpId, origin: config.webauthn.origins[0]! });
    await expect(verifyReauthentication({ userId: user.id, response: fromPasskeyOrigin as never })).resolves.toMatchObject({ deviceId });
  });
});

describe("production requirements stay intact", () => {
  it("5. production still requires the canonical LifeOS origin and refuses staging origins", async () => {
    const app = await start(productionEnv());
    expect(config.corsOrigins).toContain(CANONICAL_LIFEOS_WEB_ORIGIN);
    expect(config.webauthn.origins).toEqual(["https://trustedid.netlify.app"]);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

    expect((await startError(productionEnv({ CORS_ORIGINS: "https://trustedid.netlify.app" }))).message).toMatch(CANONICAL_LIFEOS_WEB_ORIGIN);
    for (const over of [
      { CORS_ORIGINS: `https://trustedid.netlify.app,${CANONICAL_LIFEOS_WEB_ORIGIN},${STAGING}` },
      { WEBAUTHN_ORIGINS: STAGING },
      { CORS_ORIGINS: `https://trustedid.netlify.app,${CANONICAL_LIFEOS_WEB_ORIGIN},https://portal-staging.example.app` },
    ]) {
      expect((await startError(productionEnv(over))).message, JSON.stringify(over)).toMatch(/production refuses staging origin/);
    }
    // explicit TRUSTID_DEPLOY_ENV=production behaves the same
    await start(productionEnv({ TRUSTID_DEPLOY_ENV: "production" }));
  });
});

describe("Android identities per environment", () => {
  it("9/10/11. staging trusts only the staging app; production refuses the staging app; debug certificates are never trusted", async () => {
    expect((await startError(stagingEnv({ ANDROID_APP_PACKAGE: "com.trustid.device" }))).message).toMatch(/not the staging app/);
    expect((await startError(productionEnv({ ANDROID_APP_PACKAGE: "com.trustid.device.staging" }))).message).toMatch(/not the production app/);
    expect((await startError(stagingEnv({ ANDROID_APP_SIGNING_SHA256: DEBUG_CERT }))).message).toMatch(/debug signing certificate/);
    expect((await startError(productionEnv({ ANDROID_APP_SIGNING_SHA256: DEBUG_CERT.replace(/(..)(?!$)/g, "$1:").toUpperCase() }))).message).toMatch(/debug signing certificate/);
    const debugOrigin = `android:apk-key-hash:${Buffer.from(DEBUG_CERT, "hex").toString("base64url")}`;
    expect((await startError(stagingEnv({ WEBAUTHN_ANDROID_ORIGINS: debugOrigin }))).message).toMatch(/debug signing certificate/);
    expect((await startError(stagingEnv({ ANDROID_APP_PACKAGE: "" }))).message).toMatch(/staging enrollment needs ANDROID_APP_PACKAGE/);
  });
});

describe("environment-aware OAuth bootstrap", () => {
  const redirectHosts = async () =>
    (await prisma.application.findMany({ select: { clientId: true, redirectUris: true } })).map((a) => ({
      clientId: a.clientId,
      hosts: (JSON.parse(a.redirectUris) as string[]).map((u) => new URL(u).host),
    }));

  it("12/13. staging creates only its own Portal clients (no production or development redirects) and is idempotent", async () => {
    await start(stagingEnv({ TRUSTID_STAGING_ADMIN_ORIGIN: "https://admin-staging.example.app" }));
    const first = await redirectHosts();
    expect(first.map((a) => a.clientId).sort()).toEqual(["lifeos_platform_admin_staging_public", "lifeos_portal_staging_public"]);
    expect(first.flatMap((a) => a.hosts).sort()).toEqual(["admin-staging.example.app", "portal-staging.example.app"]);
    for (const prod of PORTAL_OAUTH_CLIENTS) expect(first.map((a) => a.clientId)).not.toContain(prod.clientId);
    // the staging Portal origins are this deployment's Portal CORS origins
    expect(portalOAuthClients().map((c) => c.origin).sort()).toEqual(["https://admin-staging.example.app", STAGING_PORTAL]);

    // second boot: nothing new, nothing changed
    await start(stagingEnv({ TRUSTID_STAGING_ADMIN_ORIGIN: "https://admin-staging.example.app" }));
    expect(await redirectHosts()).toEqual(first);
  });

  it("staging refuses to start on a database holding production or local relying parties (nothing modified)", async () => {
    await prisma.application.create({
      data: { name: "LifeOS Portal", clientId: "lifeos_portal_public", type: "public", redirectUris: JSON.stringify(["https://getlifeos.app/callback"]), allowedScopes: "[]", status: "active" },
    });
    const err = await startError(stagingEnv());
    expect(err.message).toMatch(/active clients redirecting to production or local hosts: lifeos_portal_public/);
    expect(await prisma.application.count()).toBe(1);
  });

  it("invalid staging Portal configuration fails before any client is registered", async () => {
    for (const bad of ["http://portal-staging.example.app", "https://localhost:5173", "https://portal-staging.example.app/path", "not-a-url"]) {
      const err = await startError(stagingEnv({ TRUSTID_STAGING_PORTAL_ORIGIN: bad }));
      expect(err, bad).toBeInstanceOf(DeploymentConfigError);
    }
    expect(await prisma.application.count()).toBe(0);
  });

  it("production bootstrap is unchanged: the production Portal clients with their production redirects", async () => {
    await start(productionEnv());
    const ids = (await redirectHosts()).map((a) => a.clientId);
    for (const prod of PORTAL_OAUTH_CLIENTS) expect(ids).toContain(prod.clientId);
    expect(ids).toContain("elfcom_web");
  });

  it("the seed creates no applications in staging and fails on an unknown environment", () => {
    const require = createRequire(import.meta.url);
    const tsx = require.resolve("tsx/cli");
    const seed = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "seed.ts");
    const run = (extra: Record<string, string>) =>
      execFileSync(process.execPath, [tsx, seed], { env: { ...process.env, ...stagingEnv(), ...extra }, encoding: "utf8", stdio: "pipe" });
    expect(run({})).toMatch(/staging deployment, no applications seeded/);
    expect(() => run({ TRUSTID_DEPLOY_ENV: "qa" })).toThrow();
  });
});
