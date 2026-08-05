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

  console.log("Seeded applications:");
  console.log("  LifeOS client_id:", lifeosClientId);
  console.log("  Digiconomy client_id:", digiconomyClientId, "(placeholder — not connected in V1)");
  console.log("  (dev secret helper unused)", hash(randomBytes(8).toString("hex")).slice(0, 8));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
