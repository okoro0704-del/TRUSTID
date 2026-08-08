import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_EVENTS, DEVICE_STATUS } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { createEnrollmentInvite, claimEnrollment } from "../src/modules/devices/enrollment.js";
import { listPasskeys, removePasskey, renamePasskey } from "../src/modules/passkeys/service.js";
import { computeTrustLevel, getTrustCenterSummary } from "../src/modules/trust/service.js";
import { revokeAuthorization, grantAuthorization } from "../src/modules/authorization/service.js";
import { createSession, revokeSession } from "../src/modules/sessions/service.js";

async function createUser(email: string) {
  return prisma.user.create({
    data: {
      trustId: `TD-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "active",
      profile: { create: { firstName: "A", lastName: "User" } },
      contactMethods: {
        create: {
          type: "email",
          value: email,
          verifiedAt: new Date(),
          isPrimary: true,
        },
      },
    },
  });
}

describe("Trust Center services", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("computes trust tier 0 without devices and tier 1 with a trusted device", async () => {
    const user = await createUser("tier@example.com");
    let trust = await computeTrustLevel(user.id);
    expect(trust.tier).toBe(0);
    expect(trust.governmentVerified).toBe(false);

    await prisma.device.create({
      data: { userId: user.id, name: "Phone", status: DEVICE_STATUS.ACTIVE },
    });
    trust = await computeTrustLevel(user.id);
    expect(trust.tier).toBe(1);
    expect(trust.label).toMatch(/Trusted device/i);
  });

  it("creates enrollment invite, approve, and claim token", async () => {
    const user = await createUser("enroll@example.com");
    const invite = await createEnrollmentInvite(user.id);
    expect(invite.pairingCode).toHaveLength(6);
    // Master-generated codes are immediately claimable
    expect(invite.status).toBe("approved");
    expect(invite.canEnroll).toBe(true);

    const claimed = await claimEnrollment(invite.pairingCode);
    expect(claimed.enrollmentToken).toBeTruthy();
    expect(claimed.userId).toBe(user.id);

    const event = await prisma.auditEvent.findFirst({
      where: { userId: user.id, type: AUDIT_EVENTS.DEVICE_ENROLLMENT_CREATED },
    });
    expect(event).toBeTruthy();
  });

  it("renames and removes passkeys while retaining one", async () => {
    const user = await createUser("pk@example.com");
    const device = await prisma.device.create({
      data: { userId: user.id, name: "Laptop", status: DEVICE_STATUS.ACTIVE },
    });
    const a = await prisma.credential.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        credentialId: "cred-a",
        publicKey: Buffer.from([1]),
        displayName: "A",
      },
    });
    const b = await prisma.credential.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        credentialId: "cred-b",
        publicKey: Buffer.from([2]),
        displayName: "B",
      },
    });

    await renamePasskey(user.id, a.id, "Work laptop");
    const listed = await listPasskeys(user.id);
    expect(listed.find((p) => p.id === a.id)?.displayName).toBe("Work laptop");

    await removePasskey(user.id, a.id);
    await expect(removePasskey(user.id, b.id)).rejects.toThrow(/last passkey/i);
  });

  it("returns trust center summary counts", async () => {
    const user = await createUser("sum@example.com");
    await prisma.device.create({
      data: { userId: user.id, name: "Phone", status: DEVICE_STATUS.ACTIVE },
    });
    const summary = await getTrustCenterSummary(user.id);
    expect(summary?.counts.trustedDevices).toBe(1);
    expect(summary?.trust.tier).toBe(1);
  });

  it("revokes application authorization", async () => {
    const user = await createUser("app@example.com");
    const app = await prisma.application.create({
      data: {
        name: "LifeOS",
        clientId: "lifeos_test",
        type: "public",
        redirectUris: JSON.stringify(["http://localhost:5174/callback"]),
        allowedScopes: JSON.stringify([
          "openid",
          "identity.basic",
          "identity.profile",
          "identity.email",
        ]),
      },
    });
    const authId = await grantAuthorization({
      userId: user.id,
      applicationId: app.id,
      scopes: ["openid", "identity.basic"],
    });
    await revokeAuthorization(user.id, authId);
    const auth = await prisma.authorization.findUnique({ where: { id: authId } });
    expect(auth?.status).toBe("revoked");
  });

  it("terminates sessions", async () => {
    const user = await createUser("sess@example.com");
    const { session } = await createSession({ userId: user.id });
    const ok = await revokeSession(session.id, user.id);
    expect(ok).toBe(true);
  });
});
