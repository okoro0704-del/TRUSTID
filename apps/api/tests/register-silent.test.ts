import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBAUTHN_PURPOSES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import {
  beginSilentRegistration,
  completeSilentRegistration,
} from "../src/modules/authentication/register-silent.js";

vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>(
    "@simplewebauthn/server",
  );
  return {
    ...actual,
    generateRegistrationOptions: vi.fn(async () => ({
      challenge: "silent-reg-challenge",
      rp: { name: "TrustID", id: "localhost" },
      user: { id: "u", name: "TD-TEST", displayName: "Test" },
      pubKeyCredParams: [],
      timeout: 60000,
      attestation: "none",
      excludeCredentials: [],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
    })),
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        credential: {
          id: "silent-cred-id",
          publicKey: new Uint8Array(65).fill(1),
          counter: 0,
        },
      },
    })),
  };
});

function clientDataJSON(challenge: string) {
  return Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge,
      origin: "http://localhost:5173",
    }),
  ).toString("base64url");
}

describe("register-silent zero-PII onboarding", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("begins silent registration without email/phone and completes session", async () => {
    const installId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const began = await beginSilentRegistration({
      installId,
    });
    expect(began.trustId).toMatch(/^TD-/);
    expect(began.userId).toBeTruthy();
    expect(began.options.purpose).toBe(WEBAUTHN_PURPOSES.REGISTRATION);

    const user = await prisma.user.findUnique({ where: { id: began.userId } });
    expect(user?.status).toBe("pending_verification");
    const contacts = await prisma.contactMethod.count({
      where: { userId: began.userId },
    });
    expect(contacts).toBe(0);

    const completed = await completeSilentRegistration({
      userId: began.userId,
      installId,
      response: {
        id: "silent-cred-id",
        rawId: "silent-cred-id",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON("silent-reg-challenge"),
          attestationObject: "AAAA",
        },
      },
    });

    expect(completed.trustId).toBe(began.trustId);
    expect(completed.sessionToken).toBeTruthy();
    expect(completed.identity?.trustId).toBe(began.trustId);

    const active = await prisma.user.findUnique({ where: { id: began.userId } });
    expect(active?.status).toBe("active");
  });

  it("POST /v1/auth/register-silent/options rejects empty installId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register-silent/options",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
