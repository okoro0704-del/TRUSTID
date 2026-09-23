import { DEFAULT_APP_SCOPES } from "@trustid/shared";
import { prisma } from "../db/client.js";

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
}
