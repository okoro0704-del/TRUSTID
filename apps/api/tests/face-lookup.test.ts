import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { ambientSignInAndSession } from "../src/modules/trust-id/fusion.js";
import { resetTables } from "./helpers/db.js";

function face512(seed = 1) {
  return Array.from({ length: 512 }, (_, i) => ((i + seed) % 31) / 100);
}

describe("face-lookup launch flow", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    await resetTables(prisma);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns NOT_FOUND without creating a user", async () => {
    const before = await prisma.user.count();
    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/face-lookup",
      payload: {
        faceVector: face512(3),
        confidence: 0.9,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("NOT_FOUND");
    expect(res.json().canRegister).toBe(true);
    expect(await prisma.user.count()).toBe(before);
  });

  it("returns MATCH_FOUND after explicit enroll", async () => {
    const vector = face512(7);
    const installId = "22222222-2222-4222-8222-222222222222";
    const enrolled = await ambientSignInAndSession({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector,
          confidence: 0.95,
        },
      },
      allowAutoEnroll: true,
      installId,
    });
    expect(enrolled.matched).toBe(true);
    expect(enrolled.isMasterDevice).toBe(true);

    const { getInstallOccupancy } = await import(
      "../src/modules/authentication/device-install.js"
    );
    const occ = await getInstallOccupancy(installId);
    expect(occ.occupied).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/face-lookup",
      payload: {
        face: {
          modality: "face",
          vector,
          confidence: 0.95,
        },
        installId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Same install is treated as master — direct login, not approval.
    expect(["MATCH_FOUND", "PENDING_MASTER_APPROVAL"]).toContain(body.status);
    expect(body.trustId).toBe(enrolled.trustId);
    if (occ.occupied) {
      expect(body.status).toBe("MATCH_FOUND");
    }
  });
});
