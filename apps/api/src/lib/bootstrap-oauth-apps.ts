import { DEFAULT_APP_SCOPES } from "@trustid/shared";
import { prisma } from "../db/client.js";

const ELFCOM_CLIENT_ID = "elfcom_web";

const DEFAULT_ELFCOM_REDIRECTS = [
  "https://elfcom.netlify.app/auth/callback",
  "http://localhost:5180/auth/callback",
];

/**
 * Ensure ElfCom (and optional env redirects) exist as OAuth public clients.
 * Runs on API boot so Railway deploys pick up new relying parties without a manual seed.
 */
export async function bootstrapOAuthApplications() {
  const redirects = [...DEFAULT_ELFCOM_REDIRECTS];
  for (const part of (process.env.ELFCOM_OAUTH_REDIRECT_URIS ?? "").split(",")) {
    const u = part.trim();
    if (u && !redirects.includes(u)) redirects.push(u);
  }
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
}
