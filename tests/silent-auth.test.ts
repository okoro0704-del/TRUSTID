/**
 * Deliverable path: tests/silent-auth.test.ts
 * Runs via apps/api vitest (see vitest.config.ts include).
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBAUTHN_PURPOSES } from "@trustid/shared";
import { prisma } from "../apps/api/src/db/client.js";
import { resetTables } from "../apps/api/tests/helpers/db.js";
import { createZeroPiiUser } from "../apps/api/tests/helpers/zero-pii-user.js";
import {
  createSilentChallenge,
  pairSilentDeviceKey,
  silentAssert,
} from "../apps/api/src/modules/authentication/silent-auth.js";
import { buildApp } from "../apps/api/src/app.js";

vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>(
    "@simplewebauthn/server",
  );
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: {
        newCounter: 1,
        credentialID: new Uint8Array(),
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        userVerified: true,
        origin: "http://localhost:5173",
        rpID: "localhost",
      },
    })),
  };
});

function makeEs256Key() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicKeySpki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { publicKey, privateKey, publicKeySpki };
}

function signChallenge(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  challenge: string,
) {
  const signature = cryptoSign("sha256", Buffer.from(challenge, "utf8"), privateKey);
  return signature.toString("base64url");
}

describe("Zero-input silent biometric auth", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("initiates login with zero payload inputs", async () => {
    const issued = await createSilentChallenge();
    expect(issued.challenge).toBeTruthy();
    expect(issued.challengeId).toBeTruthy();
    expect(issued.purpose).toBe(WEBAUTHN_PURPOSES.SILENT_AUTHENTICATION);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/auth/silent/challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { challenge: string; purpose: string };
    expect(body.challenge.length).toBeGreaterThan(16);
    expect(body.purpose).toBe(WEBAUTHN_PURPOSES.SILENT_AUTHENTICATION);
    await app.close();
  });

  it("verifies signature, looks up Trust ID Number, and generates a session", async () => {
    const user = await createZeroPiiUser("silent@example.com", {
      trustId: "TD-SILENT01",
    });
    const { privateKey, publicKeySpki } = makeEs256Key();
    const keyId = "silent-key-test-001";

    await pairSilentDeviceKey({
      userId: user.id,
      keyId,
      publicKeySpki: publicKeySpki.toString("base64url"),
      device: {
        platform: "android",
        model: "Pixel Test",
        osVersion: "14",
      },
    });

    const { challenge } = await createSilentChallenge();
    const signature = signChallenge(privateKey, challenge);

    const result = await silentAssert({
      mode: "native",
      keyId,
      challenge,
      signature,
      device: { platform: "android", model: "Pixel Test", osVersion: "14" },
    });

    expect(result.trustId).toBe("TD-SILENT01");
    expect(result.sessionToken).toBeTruthy();
    expect(result.sessionId).toBeTruthy();
    expect(result.mode).toBe("native");

    const session = await prisma.session.findUnique({
      where: { id: result.sessionId },
    });
    expect(session?.userId).toBe(user.id);
    expect(session?.revokedAt).toBeNull();
  });

  it("POST /v1/auth/silent-assert returns device_unpaired for unknown keys", async () => {
    const app = await buildApp();
    const { challenge } = await createSilentChallenge();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/silent-assert",
      payload: {
        mode: "native",
        keyId: "never-paired-key",
        challenge,
        signature: Buffer.from("deadbeef").toString("base64url"),
        device: { platform: "android", model: "Unknown", osVersion: "1" },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe("device_unpaired");
    await app.close();
  });

  it("rejects invalid signatures without creating a session", async () => {
    const user = await createZeroPiiUser("bad-sig@example.com");
    const { publicKeySpki } = makeEs256Key();
    const other = makeEs256Key();
    const keyId = "silent-key-bad-sig";

    await pairSilentDeviceKey({
      userId: user.id,
      keyId,
      publicKeySpki: publicKeySpki.toString("base64url"),
    });

    const { challenge } = await createSilentChallenge();
    const wrongSig = signChallenge(other.privateKey, challenge);

    await expect(
      silentAssert({
        mode: "native",
        keyId,
        challenge,
        signature: wrongSig,
      }),
    ).rejects.toMatchObject({ code: "invalid_signature", statusCode: 401 });

    const sessions = await prisma.session.count({ where: { userId: user.id } });
    expect(sessions).toBe(0);
  });
});
