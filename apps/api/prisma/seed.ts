import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_APP_SCOPES } from "@trustid/shared";

const prisma = new PrismaClient();

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const lifeosClientId = "lifeos_mock_public";
  const digiconomyClientId = "digiconomy_placeholder";

  const lifeosRedirects = [
    "http://localhost:5174/callback",
    "https://lifeos011.netlify.app/callback",
    // Same-origin demo callback when LifeOS is hosted with TrustID
    "http://localhost:5173/lifeos/callback",
  ];

  await prisma.application.upsert({
    where: { clientId: lifeosClientId },
    update: {
      name: "LifeOS",
      redirectUris: JSON.stringify(lifeosRedirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
      type: "public",
    },
    create: {
      name: "LifeOS",
      clientId: lifeosClientId,
      type: "public",
      redirectUris: JSON.stringify(lifeosRedirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
    },
  });

  await prisma.application.upsert({
    where: { clientId: digiconomyClientId },
    update: {
      name: "Digiconomy",
      status: "active",
    },
    create: {
      name: "Digiconomy",
      clientId: digiconomyClientId,
      type: "public",
      redirectUris: JSON.stringify(["http://localhost:5199/callback"]),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
    },
  });

  const lidiosClientId = "TOKEN_NETWORK";
  const lidiosRedirects = [
    "http://localhost:4100/auth/trustid/return",
    "http://localhost:4100/wallet/trustid-return.html",
  ];
  // Production LIDIOS API (Railway) — set on Trust ID Railway service
  const lidiosProd =
    process.env.LIDIOS_OAUTH_REDIRECT_URI?.trim() ||
    process.env.LIDIOS_API_PUBLIC_URL?.trim();
  if (lidiosProd) {
    const base = lidiosProd.replace(/\/$/, "");
    const returnUri = base.endsWith("/auth/trustid/return")
      ? base
      : `${base}/auth/trustid/return`;
    if (!lidiosRedirects.includes(returnUri)) lidiosRedirects.push(returnUri);
  }
  for (const part of (process.env.LIDIOS_OAUTH_REDIRECT_URIS ?? "").split(",")) {
    const u = part.trim();
    if (u && !lidiosRedirects.includes(u)) lidiosRedirects.push(u);
  }
  await prisma.application.upsert({
    where: { clientId: lidiosClientId },
    update: {
      name: "LIDIOS TOKEN",
      redirectUris: JSON.stringify(lidiosRedirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
      type: "public",
    },
    create: {
      name: "LIDIOS TOKEN",
      clientId: lidiosClientId,
      type: "public",
      redirectUris: JSON.stringify(lidiosRedirects),
      allowedScopes: JSON.stringify(DEFAULT_APP_SCOPES),
      status: "active",
    },
  });

  console.log("Seeded applications:");
  console.log("  LifeOS client_id:", lifeosClientId);
  console.log("  Digiconomy client_id:", digiconomyClientId, "(placeholder — not connected in V1)");
  console.log("  LIDIOS TOKEN client_id:", lidiosClientId);
  console.log("  LIDIOS redirect URIs:", lidiosRedirects.join(", "));
  console.log("  (dev secret helper unused)", hash(randomBytes(8).toString("hex")).slice(0, 8));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
