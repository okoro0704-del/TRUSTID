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

/**
 * Connected services that can run in `http` mode, with the credential contract config.ts already
 * reads for each (environment variables in the same fallback order as config.ts, which uses `??`).
 * In staging an `http` service needs its own https base URL, and, where the service carries
 * credentials, an explicit non-placeholder secret and an explicit non-production issuer: the code
 * defaults (development secrets, production issuer names) are never acceptable there.
 * LIDIOS and Digiconomy carry no credentials (outbound health / handshake only): URL check only.
 */
type ServiceContract = {
  mode: string;
  key: "elfcom" | "datazone" | "lidios" | "digiconomy" | "platformJob" | "masterDistribution" | "finprov";
  secrets?: Array<{ label: string; chain: string[] }>;
  issuer?: { chain: string[]; codeDefault: string };
};
const CONNECTED_SERVICES: ServiceContract[] = [
  {
    mode: "ELFCOM_MODE",
    key: "elfcom",
    secrets: [
      { label: "node secret", chain: ["ELFCOM_NODE_SECRET", "LIFEOS_JWT_SECRET"] },
      { label: "capability JWT secret", chain: ["ELFCOM_CAPABILITY_JWT_SECRET", "LIFEOS_JWT_SECRET", "ELFCOM_NODE_SECRET"] },
    ],
    issuer: { chain: ["LIFEOS_JWT_ISS"], codeDefault: "lifeos" },
  },
  {
    mode: "DATAZONE_MODE",
    key: "datazone",
    secrets: [{ label: "JWT secret", chain: ["DATAZONE_JWT_SECRET", "TRUST_ID_JWT_SECRET"] }],
    issuer: { chain: ["DATAZONE_JWT_ISSUER", "ASSERTION_ISSUER"], codeDefault: "https://trustedid.netlify.app" },
  },
  {
    mode: "PLATFORM_JOB_MODE",
    key: "platformJob",
    secrets: [{ label: "JWT secret", chain: ["PLATFORM_JOB_JWT_SECRET", "TRUST_ID_JWT_SECRET"] }],
    issuer: { chain: ["PLATFORM_JOB_JWT_ISSUER"], codeDefault: "lifeos-trust-id" },
  },
  {
    mode: "MASTER_DISTRIBUTION_MODE",
    key: "masterDistribution",
    secrets: [{ label: "JWT secret", chain: ["MASTER_DISTRIBUTION_JWT_SECRET", "TRUST_ID_JWT_SECRET"] }],
    issuer: { chain: ["MASTER_DISTRIBUTION_JWT_ISSUER"], codeDefault: "lifeos-trust-id" },
  },
  { mode: "FINPROV_MODE", key: "finprov", secrets: [{ label: "API key", chain: ["FINPROV_API_KEY"] }] },
  { mode: "LIDIOS_MODE", key: "lidios" },
  { mode: "DIGICONOMY_MODE", key: "digiconomy" },
];

/** Code-default and production issuer names: never a staging issuer. */
const PRODUCTION_ISSUER_NAMES = new Set(["lifeos", "lifeos-trust-id", "https://trustedid.netlify.app", "https://trustedid.netlify.app/api"]);
/** Development defaults and obvious placeholders: never a staging secret. */
const PLACEHOLDER_SECRET = /(^|[-_.])(dev|test|demo|example|sample|placeholder|default|changeme)([-_.]|$)|change[-_]?me|change[-_]in[-_]production|not[-_]a[-_]secret/i;
const MIN_SERVICE_SECRET_LENGTH = 32;

/** The value config.ts would use from `chain` (first defined variable, `??` semantics), or null. */
function configured(env: NodeJS.ProcessEnv, chain: string[]): { name: string; value: string } | null {
  for (const name of chain) {
    if (env[name] !== undefined) return { name, value: env[name]! };
  }
  return null;
}

function assertServiceCredentials(service: ServiceContract, env: NodeJS.ProcessEnv) {
  for (const secret of service.secrets ?? []) {
    const found = configured(env, secret.chain);
    if (!found || !found.value.trim()) {
      fail(`${service.mode}=http needs its ${secret.label} (${secret.chain.join(" or ")}); the development default is not allowed in staging`);
    }
    if (found!.value.length < MIN_SERVICE_SECRET_LENGTH || PLACEHOLDER_SECRET.test(found!.value)) {
      fail(`${service.mode}=http: ${found!.name} is a development default, placeholder or shorter than ${MIN_SERVICE_SECRET_LENGTH} characters`);
    }
  }
  if (service.issuer) {
    const found = configured(env, service.issuer.chain);
    if (!found || !found.value.trim()) {
      fail(`${service.mode}=http needs an explicit token issuer (${service.issuer.chain.join(" or ")}); the default "${service.issuer.codeDefault}" is not allowed in staging`);
    }
    const issuer = found!.value.trim();
    if (PRODUCTION_ISSUER_NAMES.has(issuer.replace(/\/$/, "")) || isProductionOrigin(issuer)) {
      fail(`${service.mode}=http: ${found!.name} "${issuer}" is a production issuer; staging needs its own`);
    }
  }
}

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

  for (const service of CONNECTED_SERVICES) {
    const modeVar = service.mode;
    if (env[modeVar] !== "http") continue;
    const baseUrl = (config[service.key] as { baseUrl: string }).baseUrl;
    let origin = "";
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      /* invalid or empty: refused below */
    }
    if (!origin || !isProductionSafeOrigin(origin) || isProductionOrigin(baseUrl)) {
      fail(`${modeVar}=http points at ${baseUrl}; staging may only use its own https services`);
    }
    assertServiceCredentials(service, env);
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
