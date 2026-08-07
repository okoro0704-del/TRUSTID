import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_EVENTS, DEVICE_STATUS, WEBAUTHN_PURPOSES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import {
  storeWebAuthnChallenge,
  createSecureChallenge,
} from "../src/modules/authentication/challenges.js";

vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>(
    "@simplewebauthn/server",
  );
  return {
    ...actual,
    generateRegistrationOptions: vi.fn(async () => ({
      challenge: "reg-challenge-value",
      rp: { name: "TrustID", id: "localhost" },
      user: { id: "u", name: "TD-TEST", displayName: "Test" },
      pubKeyCredParams: [],
      timeout: 60000,
      attestation: "none",
      excludeCredentials: [],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
      },
    })),
    generateAuthenticationOptions: vi.fn(async () => ({
      challenge: "auth-challenge-value",
      timeout: 60000,
      rpId: "localhost",
      allowCredentials: [],
      userVerification: "required",
    })),
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

import {
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  loginOptions,
  registrationOptions,
  verifyLogin,
  verifyRegistration,
} from "../src/modules/authentication/webauthn.js";
import { revokeDevice } from "../src/modules/devices/service.js";

function clientDataJSON(challenge: string, type = "webauthn.create") {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge,
      origin: "http://localhost:5173",
    }),
  ).toString("base64url");
}

async function createUser(email: string) {
  return prisma.user.create({
    data: {
      trustId: `TD-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "pending_verification",
      profile: { create: { firstName: "Test", lastName: "User" } },
      contactMethods: {
        create: {
          type: "email",
          value: email,
          isPrimary: true,
          verifiedAt: new Date(),
        },
      },
    },
  });
}

describe("Trusted device credential flows", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    vi.mocked(verifyRegistrationResponse).mockReset();
    vi.mocked(verifyAuthenticationResponse).mockReset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("registration options prefer platform authenticator and required UV", async () => {
    const user = await createUser("opts@example.com");
    const options = await registrationOptions(user.id);
    expect(generateRegistrationOptions).toHaveBeenCalled();
    const call = vi.mocked(generateRegistrationOptions).mock.calls.at(-1)?.[0];
    expect(call?.authenticatorSelection?.authenticatorAttachment).toBe("platform");
    expect(call?.authenticatorSelection?.userVerification).toBe("required");
    expect(options.purpose).toBe(WEBAUTHN_PURPOSES.REGISTRATION);
    expect(options.challengeId).toBeTruthy();
  });

  it("valid WebAuthn registration creates active trusted device + public credential only", async () => {
    const user = await createUser("reg@example.com");
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
      userId: user.id,
    });

    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-unique-1",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        aaguid: "00000000-0000-0000-0000-000000000000",
      },
    } as never);

    const result = await verifyRegistration({
      userId: user.id,
      deviceName: "iPhone",
      response: {
        id: "cred-unique-1",
        rawId: "cred-unique-1",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON(challenge),
          attestationObject: "attestation",
          transports: ["internal"],
        },
      },
    });

    expect(result.device.status).toBe(DEVICE_STATUS.ACTIVE);
    const cred = await prisma.credential.findUnique({
      where: { credentialId: "cred-unique-1" },
    });
    expect(cred).toBeTruthy();
    expect(cred!.publicKey.length).toBeGreaterThan(0);
    const json = JSON.stringify(cred, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(json.toLowerCase()).not.toContain("fingerprint");
    expect(json.toLowerCase()).not.toContain("biometric");
    expect(json).not.toContain("privateKey");
    expect(Object.keys(cred!)).not.toContain("fingerprint");
    expect(Object.keys(cred!)).not.toContain("privateKey");

    const completed = await prisma.auditEvent.findFirst({
      where: { type: AUDIT_EVENTS.DEVICE_REGISTRATION_COMPLETED, userId: user.id },
    });
    expect(completed).toBeTruthy();
  });

  it("rejects invalid / unknown challenge", async () => {
    const user = await createUser("badchal@example.com");
    await expect(
      verifyRegistration({
        userId: user.id,
        response: {
          id: "x",
          rawId: "x",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataJSON("no-such-challenge"),
            attestationObject: "attestation",
          },
        },
      }),
    ).rejects.toThrow(/Challenge/);
  });

  it("rejects expired challenge", async () => {
    const user = await createUser("exp@example.com");
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
      userId: user.id,
      ttlMs: -5,
    });
    await expect(
      verifyRegistration({
        userId: user.id,
        response: {
          id: "x",
          rawId: "x",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataJSON(challenge),
            attestationObject: "attestation",
          },
        },
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("rejects wrong origin via verifyRegistrationResponse failure", async () => {
    const user = await createUser("origin@example.com");
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
      userId: user.id,
    });
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(
      new Error("Unexpected origin"),
    );
    await expect(
      verifyRegistration({
        userId: user.id,
        response: {
          id: "x",
          rawId: "x",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataJSON(challenge),
            attestationObject: "attestation",
          },
        },
      }),
    ).rejects.toThrow(/registration failed/i);
  });

  it("rejects duplicate credential ID across identities", async () => {
    const userA = await createUser("a@example.com");
    const userB = await createUser("b@example.com");
    const device = await prisma.device.create({
      data: {
        userId: userA.id,
        name: "Phone",
        status: DEVICE_STATUS.ACTIVE,
      },
    });
    await prisma.credential.create({
      data: {
        userId: userA.id,
        deviceId: device.id,
        credentialId: "shared-cred",
        publicKey: Buffer.from([9, 9, 9]),
        counter: 0n,
      },
    });

    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
      userId: userB.id,
    });
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "shared-cred",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    } as never);

    await expect(
      verifyRegistration({
        userId: userB.id,
        response: {
          id: "shared-cred",
          rawId: "shared-cred",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataJSON(challenge),
            attestationObject: "attestation",
          },
        },
      }),
    ).rejects.toThrow(/already registered/i);
  });

  it("authenticates with a valid assertion and rejects revoked credentials", async () => {
    const user = await createUser("auth@example.com");
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        name: "MacBook",
        status: DEVICE_STATUS.ACTIVE,
      },
    });
    await prisma.credential.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        credentialId: "login-cred",
        publicKey: Buffer.from([4, 5, 6]),
        counter: 1n,
        status: DEVICE_STATUS.ACTIVE,
      },
    });

    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
      challenge,
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 2,
        userVerified: true,
        credentialID: "login-cred",
      },
    } as never);

    const ok = await verifyLogin({
      response: {
        id: "login-cred",
        rawId: "login-cred",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON(challenge, "webauthn.get"),
          authenticatorData: "ad",
          signature: "sig",
          userHandle: null,
        },
      },
    });
    expect(ok.trustId).toBe(user.trustId);

    await revokeDevice(user.id, device.id);

    const challenge2 = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
      challenge: challenge2,
    });
    await expect(
      verifyLogin({
        response: {
          id: "login-cred",
          rawId: "login-cred",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataJSON(challenge2, "webauthn.get"),
            authenticatorData: "ad",
            signature: "sig",
            userHandle: null,
          },
        },
      }),
    ).rejects.toThrow(/revoked/i);
  });

  it("rejects unknown credential on authentication", async () => {
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
      challenge,
    });
    await expect(
      verifyLogin({
        response: {
          id: "missing",
          rawId: "missing",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataJSON(challenge, "webauthn.get"),
            authenticatorData: "ad",
            signature: "sig",
            userHandle: null,
          },
        },
      }),
    ).rejects.toThrow(/Unknown credential/);
  });

  it("records signature counter warning without rejecting login", async () => {
    const user = await createUser("counter@example.com");
    const device = await prisma.device.create({
      data: { userId: user.id, name: "PC", status: DEVICE_STATUS.ACTIVE },
    });
    await prisma.credential.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        credentialId: "counter-cred",
        publicKey: Buffer.from([7]),
        counter: 5n,
        status: DEVICE_STATUS.ACTIVE,
      },
    });
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
      challenge,
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 5,
        userVerified: true,
        credentialID: "counter-cred",
      },
    } as never);

    await verifyLogin({
      response: {
        id: "counter-cred",
        rawId: "counter-cred",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON(challenge, "webauthn.get"),
          authenticatorData: "ad",
          signature: "sig",
          userHandle: null,
        },
      },
    });

    const warning = await prisma.auditEvent.findFirst({
      where: {
        type: AUDIT_EVENTS.DEVICE_SIGNATURE_COUNTER_WARNING,
        userId: user.id,
      },
    });
    expect(warning).toBeTruthy();
  });

  it("device management: list rename revoke", async () => {
    const user = await createUser("mgmt@example.com");
    await loginOptions({}); // smoke
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
      userId: user.id,
    });
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "mgmt-cred",
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    } as never);
    const reg = await verifyRegistration({
      userId: user.id,
      deviceName: "Android",
      response: {
        id: "mgmt-cred",
        rawId: "mgmt-cred",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON(challenge),
          attestationObject: "attestation",
        },
      },
    });

    const { listDevices, renameDevice } = await import(
      "../src/modules/devices/service.js"
    );
    let devices = await listDevices(user.id);
    expect(devices.some((d) => d.id === reg.device.id)).toBe(true);
    await renameDevice(user.id, reg.device.id, "Pixel");
    devices = await listDevices(user.id);
    expect(devices.find((d) => d.id === reg.device.id)?.name).toBe("Pixel");

    // Keep at least one primary: add another trusted device, then revoke the first
    await prisma.device.create({
      data: {
        userId: user.id,
        name: "Backup",
        status: "active",
        trustLevel: "primary",
      },
    });
    await prisma.device.update({
      where: { id: reg.device.id },
      data: { trustLevel: "standard" },
    });

    await revokeDevice(user.id, reg.device.id);
    devices = await listDevices(user.id);
    expect(devices.find((d) => d.id === reg.device.id)?.status).toBe("revoked");
  });

  it("schema stores credential id + public key and not biometric fields", async () => {
    const { Prisma } = await import("@prisma/client");
    const fields = Object.values(Prisma.CredentialScalarFieldEnum);
    expect(fields).toContain("credentialId");
    expect(fields).toContain("publicKey");
    expect(fields).toContain("counter");
    for (const banned of [
      "fingerprint",
      "face",
      "biometricTemplate",
      "privateKey",
      "devicePin",
      "passcode",
    ]) {
      expect(fields.map((f) => f.toLowerCase())).not.toContain(banned.toLowerCase());
    }
  });
});
