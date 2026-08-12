import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import {
  assertInstallAvailableForNewTrustId,
  bindInstallToUser,
  getInstallOccupancy,
} from "../src/modules/authentication/device-install.js";

const INSTALL_A = "11111111-1111-4111-8111-111111111111";
const INSTALL_B = "22222222-2222-4222-8222-222222222222";

describe("Device install occupancy (one TrustID per phone)", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("binds install and blocks a second TrustID on the same installId", async () => {
    const user = await createZeroPiiUser("occ1@example.com");
    await bindInstallToUser(INSTALL_A, user.id);

    const occ = await getInstallOccupancy(INSTALL_A);
    expect(occ.occupied).toBe(true);
    if (occ.occupied) expect(occ.trustId).toBe(user.trustId);

    await expect(assertInstallAvailableForNewTrustId(INSTALL_A)).rejects.toThrow(
      /already has a TrustID/,
    );
  });

  it("allows a different installId to register another TrustID", async () => {
    const user = await createZeroPiiUser("occ2@example.com");
    await bindInstallToUser(INSTALL_A, user.id);
    await expect(assertInstallAvailableForNewTrustId(INSTALL_B)).resolves.toBeUndefined();
  });

  it("reclaims install after user wipe", async () => {
    const user = await createZeroPiiUser("occ3@example.com");
    await bindInstallToUser(INSTALL_A, user.id);
    await prisma.user.delete({ where: { id: user.id } });

    const occ = await getInstallOccupancy(INSTALL_A);
    expect(occ.occupied).toBe(false);

    const next = await createZeroPiiUser("occ3b@example.com");
    await expect(bindInstallToUser(INSTALL_A, next.id)).resolves.toBeUndefined();
    const again = await getInstallOccupancy(INSTALL_A);
    expect(again.occupied).toBe(true);
    if (again.occupied) expect(again.userId).toBe(next.id);
  });
});
