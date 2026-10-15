/**
 * LifeOS Portal OAuth relying parties: public clients (PKCE S256, no secret).
 *
 * One source of truth for their client ids, exact redirect URIs and browser
 * origins. Redirect URIs match exactly (no TrustID-origin shortcut), and the
 * origins are allowed by CORS without credentials: a Portal page may call the
 * token endpoint and bearer-authorized APIs, never ride the TrustID session
 * cookie.
 */
import { DEFAULT_APP_SCOPES, SCOPES } from "@trustid/shared";
import { DeploymentConfigError, deploymentEnvironment, isProductionOrigin } from "./deployment.js";

export type PortalOAuthClient = {
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  origin: string;
};

export const PORTAL_OAUTH_CLIENTS: readonly PortalOAuthClient[] = [
  {
    clientId: "lifeos_portal_public",
    name: "LifeOS Portal",
    redirectUris: ["https://getlifeos.app/callback"],
    origin: "https://getlifeos.app",
  },
  {
    clientId: "lifeos_platform_admin_public",
    name: "LifeOS Platform Admin",
    redirectUris: ["https://admin.getlifeos.app/callback"],
    origin: "https://admin.getlifeos.app",
  },
  {
    clientId: "lifeos_business_portal_public",
    name: "LifeOS Business Portal",
    redirectUris: ["https://business.getlifeos.app/callback"],
    origin: "https://business.getlifeos.app",
  },
];

/** Scopes a Portal client may be granted: defaults plus authenticated step-up. */
export const PORTAL_CLIENT_SCOPES: readonly string[] = [...new Set([...DEFAULT_APP_SCOPES, SCOPES.IDENTITY_STEP_UP])];

export const PORTAL_CLIENT_IDS: ReadonlySet<string> = new Set(PORTAL_OAUTH_CLIENTS.map((c) => c.clientId));

/** Browser origins of the Portal relying parties (CORS, without credentials). */
export const PORTAL_ORIGINS: readonly string[] = PORTAL_OAUTH_CLIENTS.map((c) => c.origin);

/**
 * Staging Portal relying parties: their own client ids, and redirect URIs / origins taken only from
 * explicit staging configuration. Staging never registers the production clients above.
 *   TRUSTID_STAGING_PORTAL_ORIGIN    → lifeos_portal_staging_public
 *   TRUSTID_STAGING_ADMIN_ORIGIN     → lifeos_platform_admin_staging_public
 *   TRUSTID_STAGING_BUSINESS_ORIGIN  → lifeos_business_portal_staging_public
 * Each must be an exact https origin that is not a production or local origin; otherwise startup
 * fails before any client is registered.
 */
const STAGING_PORTAL_SURFACES = [
  { env: "TRUSTID_STAGING_PORTAL_ORIGIN", clientId: "lifeos_portal_staging_public", name: "LifeOS Portal (staging)" },
  { env: "TRUSTID_STAGING_ADMIN_ORIGIN", clientId: "lifeos_platform_admin_staging_public", name: "LifeOS Platform Admin (staging)" },
  { env: "TRUSTID_STAGING_BUSINESS_ORIGIN", clientId: "lifeos_business_portal_staging_public", name: "LifeOS Business Portal (staging)" },
] as const;

export function stagingPortalClients(env: NodeJS.ProcessEnv = process.env): PortalOAuthClient[] {
  const clients: PortalOAuthClient[] = [];
  for (const surface of STAGING_PORTAL_SURFACES) {
    const raw = env[surface.env]?.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new DeploymentConfigError(`${surface.env} is not a valid origin`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    if (url.protocol !== "https:" || url.origin !== raw.replace(/\/$/, "") || local) {
      throw new DeploymentConfigError(`${surface.env} must be an exact https origin (got ${raw})`);
    }
    if (isProductionOrigin(url.origin)) {
      throw new DeploymentConfigError(`${surface.env} is a production origin (${url.origin}); staging may not use it`);
    }
    clients.push({ clientId: surface.clientId, name: surface.name, redirectUris: [`${url.origin}/callback`], origin: url.origin });
  }
  return clients;
}

/** The Portal relying parties of THIS deployment (production list, or the staging clients). */
export function portalOAuthClients(env: NodeJS.ProcessEnv = process.env): readonly PortalOAuthClient[] {
  return deploymentEnvironment(env) === "staging" ? stagingPortalClients(env) : PORTAL_OAUTH_CLIENTS;
}

export function portalOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return portalOAuthClients(env).map((c) => c.origin);
}

export function portalClientIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(portalOAuthClients(env).map((c) => c.clientId));
}
