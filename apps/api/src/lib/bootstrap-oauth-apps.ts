import { DEFAULT_APP_SCOPES, SCOPES } from "@trustid/shared";
import { prisma } from "../db/client.js";
import { deploymentEnvironment, isProductionOrigin } from "./deployment.js";
import { PORTAL_CLIENT_SCOPES, portalOAuthClients } from "./portal-oauth-clients.js";

const ELFCOM_CLIENT_ID = "elfcom_web";
const MYBRANDOS_CLIENT_ID = "mybrandos_public";

const DEFAULT_ELFCOM_REDIRECTS = [
  "https://elfcom.netlify.app/auth/callback",
  "http://localhost:5180/auth/callback",
];

/**
 * mybrandOS may additionally request identity.step_up: each Digi Twin request and each AI
 * likeness consent is authorized by the person through a Trust ID step-up challenge.
 */
export const MYBRANDOS_SCOPES: readonly string[] = [...new Set([...DEFAULT_APP_SCOPES, SCOPES.IDENTITY_STEP_UP])];

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
 * Create this deployment's LifeOS Portal public clients if they do not exist (production: the
 * production clients; staging: only the staging clients from TRUSTID_STAGING_*_ORIGIN). Create-only:
 * an existing client (e.g. registered by hand) is never modified here; a registration that differs
 * from the code is reported, not overwritten.
 */
export async function bootstrapPortalClients(log: (msg: string) => void = console.warn) {
  const results: Array<{ clientId: string; action: "created" | "unchanged" | "differs" }> = [];
  for (const client of portalOAuthClients()) {
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
  if (deploymentEnvironment() === "staging") {
    // Staging registers only its own Portal clients: no production or development relying parties.
    await assertNoForeignClients();
    await bootstrapPortalClients();
    return;
  }
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
      allowedScopes: JSON.stringify(MYBRANDOS_SCOPES),
      status: "active",
      type: "public",
    },
    create: {
      name: "mybrandOS",
      clientId: MYBRANDOS_CLIENT_ID,
      type: "public",
      redirectUris: JSON.stringify(mybrandRedirects),
      allowedScopes: JSON.stringify(MYBRANDOS_SCOPES),
      status: "active",
    },
  });

  await bootstrapPortalClients();
}

/**
 * Staging: refuse to start if the database already holds an active client that redirects to a
 * production or local host (e.g. a staging database seeded from elsewhere). Nothing is modified;
 * the operator disables those clients, then restarts.
 */
async function assertNoForeignClients() {
  const active = await prisma.application.findMany({ where: { status: "active" }, select: { clientId: true, redirectUris: true } });
  const foreign = active.filter((app) => {
    let uris: string[] = [];
    try {
      uris = JSON.parse(app.redirectUris) as string[];
    } catch {
      return true;
    }
    return uris.some((uri) => {
      try {
        const url = new URL(uri);
        return url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || isProductionOrigin(url.origin);
      } catch {
        return true;
      }
    });
  });
  if (foreign.length) {
    throw new Error(
      `Deployment configuration: staging database has active clients redirecting to production or local hosts: ${foreign.map((a) => a.clientId).join(", ")}`,
    );
  }
}
