/**
 * Startup guard: refuse to run when this deployment's trust configuration crosses environments.
 * Runs in buildApp() before any OAuth client is bootstrapped or a request is served.
 *
 * Production: keeps its existing requirements (canonical LifeOS CORS origin), refuses staging
 * origins and staging / debug Android identities.
 * Staging: NODE_ENV=production (strict secrets, attestation on), explicit staging RP ID / passkey
 * origin / CORS / issuer, no production origin anywhere, no connected service pointing at
 * production, no development bypass flags, staging Android identity only.
 */
import {
  ANDROID_PACKAGE,
  DeploymentConfigError,
  KNOWN_DEBUG_CERT_SHA256,
  androidOriginDigests,
  certDigests,
  deploymentEnvironment,
  isProductionOrigin,
  isStagingOrigin,
  type DeploymentEnvironment,
} from "./deployment.js";
import { assertCanonicalLifeOsCors, config, isProductionSafeOrigin } from "./config.js";
import { portalOAuthClients } from "./portal-oauth-clients.js";

const fail = (message: string): never => {
  throw new DeploymentConfigError(message);
};

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Development flags that must never be on outside development. */
const STAGING_FORBIDDEN_FLAGS = ["OTP_EXPOSE_DEBUG", "EXPOSE_SESSION_TOKEN_IN_BODY", "ALLOW_LEGACY_PII_SCOPES", "LIFEOS_AUTH_BYPASS"];

/** Connected services with an `http` mode and the config key holding their base URL. */
const CONNECTED_SERVICES = [
  ["ELFCOM_MODE", "elfcom"],
  ["DATAZONE_MODE", "datazone"],
  ["LIDIOS_MODE", "lidios"],
  ["DIGICONOMY_MODE", "digiconomy"],
  ["PLATFORM_JOB_MODE", "platformJob"],
  ["MASTER_DISTRIBUTION_MODE", "masterDistribution"],
  ["FINPROV_MODE", "finprov"],
] as const;

function assertAndroidIdentity(environment: DeploymentEnvironment, env: NodeJS.ProcessEnv) {
  const packages = list(env.ANDROID_APP_PACKAGE);
  const expected = environment === "staging" ? ANDROID_PACKAGE.staging : ANDROID_PACKAGE.production;
  for (const pkg of packages) {
    if (pkg !== expected) fail(`ANDROID_APP_PACKAGE "${pkg}" is not the ${environment} app (${expected})`);
  }
  const digests = [...certDigests(env.ANDROID_APP_SIGNING_SHA256), ...androidOriginDigests(env.WEBAUTHN_ANDROID_ORIGINS)];
  for (const digest of digests) {
    if (KNOWN_DEBUG_CERT_SHA256.has(digest)) fail("a debug signing certificate is configured as a trusted Android app identity");
  }
  if (environment === "staging" && env.MASTER_DEVICE_ENROLLMENT === "enabled") {
    if (!packages.length) fail(`staging enrollment needs ANDROID_APP_PACKAGE=${ANDROID_PACKAGE.staging}`);
    if (!certDigests(env.ANDROID_APP_SIGNING_SHA256).length) fail("staging enrollment needs the staging ANDROID_APP_SIGNING_SHA256");
  }
}

function assertProduction(env: NodeJS.ProcessEnv) {
  assertCanonicalLifeOsCors(config.corsOrigins, false);
  const rpID = config.webauthn.rpID;
  const trusted = [...config.corsOrigins, ...config.webauthn.origins, `https://${rpID}`];
  for (const origin of trusted) {
    if (isStagingOrigin(origin)) fail(`production refuses staging origin ${origin}`);
  }
  assertAndroidIdentity("production", env);
}

function assertStaging(env: NodeJS.ProcessEnv) {
  // Explicit identity: nothing derived, nothing defaulted.
  const rpID = env.WEBAUTHN_RP_ID?.trim() || fail("staging requires WEBAUTHN_RP_ID");
  const origin = env.WEBAUTHN_ORIGIN?.trim() || fail("staging requires WEBAUTHN_ORIGIN");
  const issuer = env.OIDC_ISSUER?.trim() || fail("staging requires OIDC_ISSUER");
  const cors = list(env.CORS_ORIGINS);
  if (!cors.length) fail("staging requires CORS_ORIGINS");
  if (!isProductionSafeOrigin(origin)) fail(`WEBAUTHN_ORIGIN must be an exact https origin (got ${origin})`);
  const originHost = new URL(origin).hostname;
  if (originHost !== rpID && !originHost.endsWith(`.${rpID}`)) fail(`WEBAUTHN_ORIGIN ${origin} is not within WEBAUTHN_RP_ID ${rpID}`);

  for (const value of cors) {
    if (!isProductionSafeOrigin(value)) fail(`CORS_ORIGINS entry ${value} is not an exact https origin`);
  }
  const passkeyOrigins = config.webauthn.origins;
  for (const value of passkeyOrigins) {
    if (!isProductionSafeOrigin(value)) fail(`passkey origin ${value} is not an exact https origin`);
  }
  const checks: Array<[string, string]> = [
    ["WEBAUTHN_RP_ID", `https://${rpID}`],
    ["OIDC_ISSUER", issuer],
    ...(env.ASSERTION_ISSUER?.trim() ? ([["ASSERTION_ISSUER", env.ASSERTION_ISSUER.trim()]] as Array<[string, string]>) : []),
    ...config.corsOrigins.map((o) => ["CORS", o] as [string, string]),
    ...passkeyOrigins.map((o) => ["passkey origin", o] as [string, string]),
    ...portalOAuthClients(env).flatMap((c) => c.redirectUris.map((u) => [`${c.clientId} redirect`, u] as [string, string])),
  ];
  for (const [what, value] of checks) {
    if (isProductionOrigin(value)) fail(`staging refuses production ${what} ${value}`);
  }

  for (const flag of STAGING_FORBIDDEN_FLAGS) {
    if (env[flag] && env[flag] !== "false") fail(`${flag} is not allowed in staging`);
  }
  if (env.MASTER_DEVICE_ATTESTATION) fail("MASTER_DEVICE_ATTESTATION may not be set in staging (attestation is always required)");

  for (const [modeVar, key] of CONNECTED_SERVICES) {
    if (env[modeVar] !== "http") continue;
    const baseUrl = (config[key] as { baseUrl: string }).baseUrl;
    let origin = "";
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      /* invalid or empty: refused below */
    }
    if (!origin || !isProductionSafeOrigin(origin) || isProductionOrigin(baseUrl)) {
      fail(`${modeVar}=http points at ${baseUrl}; staging may only use its own https services`);
    }
  }
  assertAndroidIdentity("staging", env);
}

/** Validate this deployment's trust configuration; throws DeploymentConfigError. Returns the environment. */
export function assertDeploymentSecurity(env: NodeJS.ProcessEnv = process.env): DeploymentEnvironment {
  const environment = deploymentEnvironment(env);
  if (environment === "production") assertProduction(env);
  if (environment === "staging") assertStaging(env);
  return environment;
}
