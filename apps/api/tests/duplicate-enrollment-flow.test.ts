import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { facePayload } from "./helpers/face.js";
import { biometricMatcher } from "../src/modules/trust-id/matcher.js";
import {
  ambientSignInAndSession,
  autoEnrollFromBiometrics,
} from "../src/modules/trust-id/fusion.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";

describe("duplicate enrollment flow", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("blocks a duplicate candidate before creating another user", async () => {
    const trustId = newTrustId();
    const name = commitName("Existing", "Person");
    const existing = await prisma.user.create({
      data: {
        trustId,
        status: "active",
        profile: {
          create: {
            nameCommitment: name.nameCommitment,
            nameSalt: name.nameSalt,
          },
        },
      },
    });
    await biometricMatcher.enrollTemplate({
      userId: existing.id,
      trustId,
      biometric: facePayload(77),
    });

    await expect(
      autoEnrollFromBiometrics({ payload: { face: facePayload(77) } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DUPLICATE_ENROLLMENT_REVIEW_REQUIRED",
    });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.biometricEmbedding.count()).toBe(1);
    const audit = await prisma.auditEvent.findFirst({
      where: { type: "biometric.match_failed" },
    });
    expect(audit?.metadata).toContain("duplicate_enrollment_blocked");
    expect(audit?.metadata).not.toContain("embedding");
  });

  it("does not mint a session when unknown-device master approval is unavailable", async () => {
    const trustId = newTrustId();
    const name = commitName("Legacy", "Account");
    const existing = await prisma.user.create({
      data: {
        trustId,
        status: "active",
        profile: {
          create: {
            nameCommitment: name.nameCommitment,
            nameSalt: name.nameSalt,
          },
        },
      },
    });
    await biometricMatcher.enrollTemplate({
      userId: existing.id,
      trustId,
      biometric: facePayload(91),
    });

    const result = await ambientSignInAndSession({
      payload: {
        face: facePayload(91, {
          deviceFingerprint: "unknown-device-assurance-test",
        }),
      },
      allowAutoEnroll: false,
    });

    expect(result.matched).toBe(true);
    expect(result.needsMasterApproval).toBe(true);
    expect("sessionToken" in result).toBe(false);
    expect(await prisma.session.count()).toBe(0);
  });
});
