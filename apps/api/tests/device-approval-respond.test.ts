import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE_APPROVAL_STATUS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { createSession } from "../src/modules/sessions/service.js";
import {
  createDeviceApprovalRequest,
  claimApprovalResult,
} from "../src/modules/device-approval/service.js";
import {
  MockElfComConsentDispatcher,
  setElfComConsentDispatcher,
  resetElfComConsentDispatcher,
} from "../src/modules/elfcom/index.js";
import { getInstallOccupancy } from "../src/modules/authentication/device-install.js";
import { resetTables } from "./helpers/db.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";

const INSTALL_ID = "11111111-1111-4111-8111-111111111111";

describe("Master device approval respond pipeline", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    await resetTables(prisma);
    resetElfComConsentDispatcher();
    setElfComConsentDispatcher(new MockElfComConsentDispatcher());
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("TRUST without passkey works for face-first primary session and binds install", async () => {
    const user = await createZeroPiiUser("master-face@example.com");
    const primary = await prisma.device.create({
      data: {
        userId: user.id,
        name: "Master Phone",
        status: DEVICE_STATUS.ACTIVE,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      },
    });
    const { token } = await createSession({
      userId: user.id,
      deviceId: primary.id,
      kind: "ambient_enroll",
    });

    const created = await createDeviceApprovalRequest({
      trustId: user.trustId,
      deviceName: "Chrome PWA",
      guestSessionId: INSTALL_ID,
    });

    const respond = await app.inject({
      method: "POST",
      url: "/v1/auth/device-approval/respond",
      headers: {
        cookie: `trustid_session=${token}`,
        "content-type": "application/json",
      },
      payload: {
        requestId: created.requestId,
        action: "TRUST",
      },
    });

    expect(respond.statusCode).toBe(200);
    expect(respond.json().status).toBe(DEVICE_APPROVAL_STATUS.APPROVED);

    const claim = await claimApprovalResult(created.pollToken);
    expect(claim.mode).toBe("ambient");
    expect(claim.sessionToken).toBeTruthy();

    const occ = await getInstallOccupancy(INSTALL_ID);
    expect(occ.occupied).toBe(true);
    if (occ.occupied) {
      expect(occ.userId).toBe(user.id);
    }
  });

  it("DECLINE marks request rejected", async () => {
    const user = await createZeroPiiUser("master-decline@example.com");
    const primary = await prisma.device.create({
      data: {
        userId: user.id,
        name: "Master Phone",
        status: DEVICE_STATUS.ACTIVE,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      },
    });
    const { token } = await createSession({
      userId: user.id,
      deviceId: primary.id,
      kind: "master",
    });

    const created = await createDeviceApprovalRequest({
      trustId: user.trustId,
      deviceName: "Android APK",
    });

    const respond = await app.inject({
      method: "POST",
      url: "/v1/auth/device-approval/respond",
      headers: {
        cookie: `trustid_session=${token}`,
        "content-type": "application/json",
      },
      payload: {
        requestId: created.requestId,
        action: "DECLINE",
      },
    });

    expect(respond.statusCode).toBe(200);
    expect(respond.json().status).toBe(DEVICE_APPROVAL_STATUS.DECLINED);
  });
});
