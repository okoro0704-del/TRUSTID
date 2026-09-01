import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS,
  BIOMETRIC_MODALITIES,
  MASTER_AUTH_CHALLENGE_STATUS,
  MASTER_STEP_UP_ACTIONS,
  TRUST_ID_ACCESS_LEVELS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { biometricMatcher } from "../src/modules/trust-id/matcher.js";
import {
  issueMasterChallenge,
  approveMasterChallenge,
} from "../src/modules/trust-id/challenges.js";
import {
  registerMasterDevice,
} from "../src/modules/trust-id/master-device.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";

/** Deterministic test embedding — simulates client capture output */
function faceEmbedding(seed: number): number[] {
  const v = Array.from({ length: 16 }, (_, i) => Math.sin(seed + i * 0.3));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

async function seedUser(trustId: string, embedding: number[]) {
  const nameCommit = commitName("Test", "User");
  const user = await prisma.user.create({
    data: {
      trustId,
      status: "active",
      profile: {
        create: {
          nameCommitment: nameCommit.nameCommitment,
          nameSalt: nameCommit.nameSalt,
        },
      },
    },
  });
  await biometricMatcher.enrollTemplate({
    userId: user.id,
    biometric: {
      modality: BIOMETRIC_MODALITIES.FACE,
      embedding,
    },
  });
  return user;
}

describe("Trust ID identity-first biometric engine", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("matches identity via 1:N on an unauthenticated secondary device", async () => {
    const embedding = faceEmbedding(42);
    const user = await seedUser(newTrustId(), embedding);

    const match = await biometricMatcher.matchOneToMany({
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        embedding: faceEmbedding(42.001),
        deviceFingerprint: "secondary-terminal-uuid-001",
      },
    });

    expect(match.matched).toBe(true);
    expect(match.userId).toBe(user.id);
    expect(match.trustId).toBe(user.trustId);
    expect(match.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.UNIVERSAL);
    expect(match.isMasterDevice).toBe(false);
    expect(match.similarity).toBeGreaterThan(0.99);
  });

  it("grants MASTER access when terminal matches bound Master Device", async () => {
    const embedding = faceEmbedding(7);
    const user = await seedUser(newTrustId(), embedding);
    const masterFp = "master-phone-secure-enclave-uuid";

    await registerMasterDevice({
      userId: user.id,
      deviceFingerprint: masterFp,
      publicKey: Buffer.from("test-master-pubkey").toString("base64url"),
    });

    const match = await biometricMatcher.matchOneToMany({
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        embedding: faceEmbedding(7.001),
        deviceFingerprint: masterFp,
      },
      requireMasterAccess: true,
    });

    expect(match.matched).toBe(true);
    expect(match.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.MASTER);
    expect(match.isMasterDevice).toBe(true);
  });

  it("issues and approves Master Device step-up for sensitive action", async () => {
    const embedding = faceEmbedding(99);
    const user = await seedUser(newTrustId(), embedding);
    const masterFp = "master-device-for-stepup";

    await registerMasterDevice({
      userId: user.id,
      deviceFingerprint: masterFp,
      publicKey: Buffer.from("stepup-pubkey").toString("base64url"),
    });

    const issued = await issueMasterChallenge({
      userId: user.id,
      action: MASTER_STEP_UP_ACTIONS.WALLET_TRANSFER,
      payload: { amountMinor: 50000, currency: "NGN" },
      requesterFingerprint: "secondary-kiosk-terminal",
    });

    expect(issued.challengeId).toBeTruthy();
    expect(issued.status).toBe(MASTER_AUTH_CHALLENGE_STATUS.PENDING);

    const approved = await approveMasterChallenge({
      userId: user.id,
      challengeId: issued.challengeId,
      deviceFingerprint: masterFp,
      signature: "mock-master-signature-base64url",
    });

    expect(approved.status).toBe(MASTER_AUTH_CHALLENGE_STATUS.APPROVED);
    expect(approved.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.MASTER);

    const audit = await prisma.auditEvent.findMany({
      where: {
        userId: user.id,
        type: {
          in: [
            AUDIT_EVENTS.MASTER_AUTH_CHALLENGE_ISSUED,
            AUDIT_EVENTS.MASTER_AUTH_CHALLENGE_APPROVED,
          ],
        },
      },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("POST /v1/trust-id/verify-biometric creates session for matched identity", async () => {
    const embedding = faceEmbedding(3);
    const user = await seedUser(newTrustId(), embedding);
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/trust-id/verify-biometric",
      payload: {
        biometric: {
          modality: BIOMETRIC_MODALITIES.FACE,
          embedding: faceEmbedding(3.001),
          deviceFingerprint: "any-terminal-africa-001",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matched: boolean;
      trustId: string;
      accessLevel: string;
    };
    expect(body.matched).toBe(true);
    expect(body.trustId).toBe(user.trustId);
    expect(body.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.UNIVERSAL);
    await app.close();
  });
});
