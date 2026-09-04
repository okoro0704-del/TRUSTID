import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { resetTables } from "./helpers/db.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";
import { MATCH_STRATEGIES } from "../src/modules/trust-id/fast-vector-match.js";

function face512(seed = 1) {
  return Array.from({ length: 512 }, (_, i) => ((i + seed) % 31) / 100);
}

describe("1:1 vs 1:N dual-path biometric login", () => {
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

  it("uses 1:N global search without cachedTrustId", async () => {
    const vector = face512(7);
    const installId = "66666666-6666-4666-8666-666666666666";

    const enroll = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector,
          confidence: 0.95,
        },
        installId,
        deviceFingerprint: "hw-one-to-n-device-fingerprint-01",
      },
    });
    expect(enroll.statusCode).toBe(200);

    __clearHotVectorCacheForTests();

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/biometric-login",
      payload: {
        faceVector: vector,
        installId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("MATCH_FOUND");
    expect(body.strategy).toBe(MATCH_STRATEGIES.GLOBAL_1_N);
    expect(typeof body.durationMs).toBe("number");
  });

  it("uses 1:1 direct verification with cachedTrustId", async () => {
    const vector = face512(8);
    const installId = "77777777-7777-4777-8777-777777777777";

    const enroll = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector,
          confidence: 0.95,
        },
        installId,
        deviceFingerprint: "hw-one-to-one-device-fingerprint-02",
      },
    });
    expect(enroll.statusCode).toBe(200);
    const trustId = enroll.json().trustId as string;

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/fast-vector-match",
      payload: {
        vector,
        installId,
        cachedTrustId: trustId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("MATCH_FOUND");
    expect(body.strategy).toBe(MATCH_STRATEGIES.DIRECT_1_1);
    expect(body.trustId).toBe(trustId);
    expect(typeof body.durationMs).toBe("number");
    expect(body.durationMs).toBeLessThan(200);
  });

  it("falls back to 1:N when cachedTrustId face does not match", async () => {
    const vectorA = face512(11);
    const vectorB = face512(99);
    const installA = "88888888-8888-4888-8888-888888888888";
    const installB = "99999999-9999-4999-8999-999999999999";

    const a = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: vectorA,
          confidence: 0.95,
        },
        installId: installA,
        deviceFingerprint: "hw-switch-a-device-fingerprint-03",
      },
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/identity/register-trust-id",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: vectorB,
          confidence: 0.95,
        },
        installId: installB,
        deviceFingerprint: "hw-switch-b-device-fingerprint-04",
      },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const trustA = a.json().trustId as string;
    const trustB = b.json().trustId as string;

    // Present face B while claiming cached Trust A ? 1:1 miss ? 1:N finds B
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/biometric-login",
      payload: {
        faceVector: vectorB,
        cachedTrustId: trustA,
        installId: installB,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("MATCH_FOUND");
    expect(body.trustId).toBe(trustB);
    expect(body.strategy).toBe(MATCH_STRATEGIES.GLOBAL_1_N);
  });
});
