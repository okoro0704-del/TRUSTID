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
