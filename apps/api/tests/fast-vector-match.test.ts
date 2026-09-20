import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { resetTables } from "./helpers/db.js";
import { face512, facePayload } from "./helpers/face.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";

describe("fast-vector-match cascade", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects non-512 vectors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/fast-vector-match",
      payload: { vector: [0.1, 0.2, 0.3] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns NOT_FOUND quickly with durationMs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/fast-vector-match",
      payload: {
        vector: face512(99),
        modelName: facePayload(99).modelName,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("NOT_FOUND");
    expect(body.canRegister).toBe(true);
    expect(typeof body.durationMs).toBe("number");
    expect(body.durationMs).toBeLessThan(500);
  });

  it("matches enrolled face and hits hot cache on second login", async () => {
    const vector = face512(42);
    const installId = "55555555-5555-4555-8555-555555555555";

    const enroll = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: facePayload(42),
        installId,
        deviceFingerprint: "hw-fast-vector-device-fingerprint-01",
      },
    });
    expect(enroll.statusCode).toBe(200);
    const trustId = enroll.json().trustId as string;

    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/fast-vector-match",
      payload: {
        vector,
        installId,
        modelName: facePayload(42).modelName,
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("MATCH_FOUND");
    expect(first.json().trustId).toBe(trustId);
    expect(typeof first.json().durationMs).toBe("number");

    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/fast-vector-match",
      payload: {
        vector,
        installId,
        modelName: facePayload(42).modelName,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("MATCH_FOUND");
    expect(second.json().durationMs).toBeLessThan(200);
  });
});
