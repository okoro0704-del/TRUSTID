import { DEFAULT_APP_SCOPES } from "@trustid/shared";
import { prisma } from "../db/client.js";
import { PORTAL_CLIENT_SCOPES, PORTAL_OAUTH_CLIENTS } from "./portal-oauth-clients.js";

const ELFCOM_CLIENT_ID = "elfcom_web";
const MYBRANDOS_CLIENT_ID = "mybrandos_public";

const DEFAULT_ELFCOM_REDIRECTS = [
  "https://elfcom.netlify.app/auth/callback",
  "http://localhost:5180/auth/callback",
];

const DEFAULT_MYBRANDOS_REDIRECTS = [
  "http://localhost:5176/auth/callback",
];

function configuredRedirects(defaults: string[], envName: string): string[] {
  const redirects = [...defaults];
  for (const part of (process.env[envName] ?? "").split(",")) {
    const redirect = part.trim();
    if (redirect && !redirects.includes(redirect)) redirects.push(redirect);
  }
  return redirects;
}

/**
 * Create the LifeOS Portal public clients if they do not exist. Create-only:
 * an existing client (e.g. registered by hand) is never modified here; a
 * registration that differs from the code is reported, not overwritten.
 */
export async function bootstrapPortalClients(log: (msg: string) => void = console.warn) {
  const results: Array<{ clientId: string; action: "created" | "unchanged" | "differs" }> = [];
  for (const client of PORTAL_OAUTH_CLIENTS) {
    const existing = await prisma.application.findUnique({ where: { clientId: client.clientId } });
    if (!existing) {
      await prisma.application.create({
        data: {
          name: client.name,
          clientId: client.clientId,
          type: "public",
          clientSecretHash: null,
          redirectUris: JSON.stringify(client.redirectUris),
          allowedScopes: JSON.stringify(PORTAL_CLIENT_SCOPES),
          status: "active",
        },
      });
      results.push({ clientId: client.clientId, action: "created" });
      continue;
    }
    const same =
      existing.type === "public" &&
      existing.redirectUris === JSON.stringify(client.redirectUris) &&
      existing.allowedScopes === JSON.stringify(PORTAL_CLIENT_SCOPES);
    if (!same) {
      log(`[oauth] ${client.clientId} exists with a registration that differs from code; left unchanged`);
    }
    results.push({ clientId: client.clientId, action: same ? "unchanged" : "differs" });
  }
  return results;
}

/**
 * Ensure ElfCom (and optional env redirects) exist as OAuth public clients.
 * Runs on API boot so Railway deploys pick up new relying parties without a manual seed.
 */
export async function bootstrapOAuthApplications() {
  const redirects = configuredRedirects(DEFAULT_ELFCOM_REDIRECTS, "ELFCOM_OAUTH_REDIRECT_URIS");
  const single = process.env.ELFCOM_OAUTH_REDIRECT_URI?.trim();
  if (single && !redirects.includes(single)) redirects.push(single);

  await prisma.application.upsert({
    where: { clientId: ELFCOM_CLIENT_ID },
    update: {
      name: "ElfCom",
      redirectUris: JSON.stringify(redirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
      type: "public",
    },
    create: {
      name: "ElfCom",
      clientId: ELFCOM_CLIENT_ID,
      type: "public",
      redirectUris: JSON.stringify(redirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
    },
  });

  const mybrandRedirects = configuredRedirects(
    DEFAULT_MYBRANDOS_REDIRECTS,
    "MYBRANDOS_OAUTH_REDIRECT_URIS",
  );
  await prisma.application.upsert({
    where: { clientId: MYBRANDOS_CLIENT_ID },
    update: {
      name: "mybrandOS",
      redirectUris: JSON.stringify(mybrandRedirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
      type: "public",
    },
    create: {
      name: "mybrandOS",
      clientId: MYBRANDOS_CLIENT_ID,
      type: "public",
      redirectUris: JSON.stringify(mybrandRedirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
    },
  });

  await bootstrapPortalClients();
}
