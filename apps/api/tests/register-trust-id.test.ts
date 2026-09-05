import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { resetTables } from "./helpers/db.js";

function face512(seed = 1) {
  return Array.from({ length: 512 }, (_, i) => ((i + seed) % 31) / 100);
}

describe("register-trust-id + install-unlock", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    await resetTables(prisma);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("registers Trust ID with Master Device binding", async () => {
    const installId = "33333333-3333-4333-8333-333333333333";
    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: face512(11),
          confidence: 0.95,
        },
        installId,
        deviceName: "Master Phone",
        deviceFingerprint: "hw-fingerprint-master-phone-01",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.isMasterDevice).toBe(true);
    expect(body.device.isMasterDevice).toBe(true);
    expect(body.trustId).toMatch(/^TD-/);

    const masters = await prisma.masterDevice.findMany({
      where: { userId: body.user.id },
    });
    expect(masters).toHaveLength(1);
    expect(masters[0]!.isMasterDevice).toBe(true);

    const primary = await prisma.device.findFirst({
      where: { userId: body.user.id },
    });
    expect(primary?.trustLevel).toBe("primary");
  });

  it("rejects install-unlock without WebAuthn assertion", async () => {
    const installId = "44444444-4444-4444-8444-444444444444";
    const created = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: face512(22),
          confidence: 0.92,
        },
        installId,
        deviceFingerprint: "hw-fingerprint-unlock-device-02",
      },
    });
    expect(created.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/auth/install-unlock",
      payload: { installId, localAuthOk: true },
    });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    const options = await app.inject({
      method: "POST",
      url: "/v1/auth/install-unlock/options",
      payload: { installId },
    });
    expect(options.statusCode).toBe(403);
    expect(options.json().error).toBe("passkey_required");
  });
});
