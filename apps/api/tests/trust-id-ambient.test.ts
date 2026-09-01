import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIOMETRIC_MODALITIES,
  BIOMETRIC_FUSION_THRESHOLD,
  TRUST_ID_ACCESS_LEVELS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { biometricMatcher } from "../src/modules/trust-id/matcher.js";
import {
  ambientSignInAndSession,
  matchMultiModalFusion,
} from "../src/modules/trust-id/fusion.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";

function faceEmbedding(seed: number): number[] {
  const v = Array.from({ length: 16 }, (_, i) => Math.sin(seed + i * 0.3));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function fpEmbedding(seed: number): number[] {
  const v = Array.from({ length: 16 }, (_, i) => Math.cos(seed + i * 0.25));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

async function seedDualModalUser(trustId: string, faceSeed: number, fpSeed: number) {
  const nameCommit = commitName("Ambient", "User");
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
    biometric: { modality: BIOMETRIC_MODALITIES.FACE, embedding: faceEmbedding(faceSeed) },
  });
  await biometricMatcher.enrollTemplate({
    userId: user.id,
    biometric: {
      modality: BIOMETRIC_MODALITIES.FINGERPRINT,
      embedding: fpEmbedding(fpSeed),
    },
  });
  return user;
}

describe("ambient zero-UI multi-modal fusion", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fuses face + fingerprint scores above threshold", async () => {
    const user = await seedDualModalUser(newTrustId(), 10, 20);

    const fusion = await matchMultiModalFusion({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          embedding: faceEmbedding(10.001),
        },
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          embedding: fpEmbedding(20.001),
        },
      },
    });

    expect(fusion.matched).toBe(true);
    expect(fusion.userId).toBe(user.id);
    expect(fusion.fusionScore).toBeGreaterThanOrEqual(BIOMETRIC_FUSION_THRESHOLD);
    expect(fusion.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.UNIVERSAL);
  });

  it("auto-enrolls and signs in on unknown biometric (zero-UI onboarding)", async () => {
    const result = await ambientSignInAndSession({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          embedding: faceEmbedding(999),
        },
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          embedding: fpEmbedding(888),
        },
      },
      allowAutoEnroll: true,
    });

    expect(result.matched).toBe(true);
    expect(result.enrolled).toBe(true);
    expect(result.trustId).toMatch(/^TD-/);
    expect(result.sessionToken).toBeTruthy();
  });

  it("POST /v1/trust-id/ambient-signin issues session", async () => {
    const user = await seedDualModalUser(newTrustId(), 5, 15);
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/trust-id/ambient-signin",
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          embedding: faceEmbedding(5.001),
        },
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          embedding: fpEmbedding(15.001),
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { matched: boolean; trustId: string; fusionScore: number };
    expect(body.matched).toBe(true);
    expect(body.trustId).toBe(user.trustId);
    expect(body.fusionScore).toBeGreaterThan(0);
    await app.close();
  });
});
