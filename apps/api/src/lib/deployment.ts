/**
 * Deployment environment of this TrustID API: development, production or staging.
 *
 * Production and staging both run with NODE_ENV=production (strict secrets, attestation always on).
 * They differ in which origins, OAuth clients and Android identities they may trust, and must never
 * trust each other's:
 *   - TRUSTID_DEPLOY_ENV=staging   → staging (requires NODE_ENV=production)
 *   - NODE_ENV=production, TRUSTID_DEPLOY_ENV unset or "production" → production
 *   - otherwise                    → development (local and tests)
 * Any other TRUSTID_DEPLOY_ENV value fails closed.
 *
 * Production keeps working without TRUSTID_DEPLOY_ENV, so enabling this needs no production change.
 */

export type DeploymentEnvironment = "development" | "production" | "staging";

export class DeploymentConfigError extends Error {
  constructor(message: string) {
    super(`Deployment configuration: ${message}`);
    this.name = "DeploymentConfigError";
  }
}

export function deploymentEnvironment(env: NodeJS.ProcessEnv = process.env): DeploymentEnvironment {
  const raw = env.TRUSTID_DEPLOY_ENV?.trim() ?? "";
  if (raw && raw !== "production" && raw !== "staging") {
    throw new DeploymentConfigError(`TRUSTID_DEPLOY_ENV must be "production" or "staging", not "${raw}"`);
  }
  const productionRuntime = env.NODE_ENV === "production";
  if (raw === "staging") {
    if (!productionRuntime) throw new DeploymentConfigError("staging must run with NODE_ENV=production");
    return "staging";
  }
  if (raw === "production" && !productionRuntime) {
    throw new DeploymentConfigError("TRUSTID_DEPLOY_ENV=production requires NODE_ENV=production");
  }
  return productionRuntime ? "production" : "development";
}

/**
 * Hosts of production TrustID / LifeOS surfaces. Staging may never trust them (CORS, passkeys, OAuth
 * redirects, issuer, connected services).
 */
export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  "trustedid.netlify.app",
  "trustid.getlifeos.app",
  "lucid-integrity-production.up.railway.app",
  "getlifeos.app",
  "www.getlifeos.app",
  "admin.getlifeos.app",
  "business.getlifeos.app",
  "lifeosapp.getlifeos.app",
  "lifeos011.netlify.app",
  "elfcom.netlify.app",
]);

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A production TrustID / LifeOS origin, or a production Railway service (`*-production.up.railway.app`). */
export function isProductionOrigin(origin: string): boolean {
  const host = hostOf(origin) ?? origin.toLowerCase();
  return PRODUCTION_HOSTS.has(host) || /-production\.up\.railway\.app$/.test(host);
}

/** A staging origin by name (`staging` as a host label or label part). Production refuses these. */
export function isStagingOrigin(origin: string): boolean {
  const host = hostOf(origin) ?? origin.toLowerCase();
  return /(^|[.-])staging([.-]|$)/.test(host);
}

/**
 * Android signing certificates that must never be trusted for a release (production or staging):
 * the Android debug certificate that signed the development-channel TrustID.apk.
 */
export const KNOWN_DEBUG_CERT_SHA256: ReadonlySet<string> = new Set([
  "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa",
]);

export const ANDROID_PACKAGE = { production: "com.trustid.device", staging: "com.trustid.device.staging" } as const;

/** Lowercase hex SHA-256 digests from a comma list (hex or colon-hex). */
export function certDigests(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/:/g, ""))
    .filter(Boolean);
}

/** Certificate digests named by `android:apk-key-hash:<base64url>` passkey origins. */
export function androidOriginDigests(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("android:apk-key-hash:"))
    .map((s) => Buffer.from(s.slice("android:apk-key-hash:".length), "base64url").toString("hex"));
}
