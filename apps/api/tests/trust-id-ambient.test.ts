import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIOMETRIC_MODALITIES,
  BIOMETRIC_SINGLE_MODALITY_THRESHOLD,
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

describe("ambient single-biometric OR sign-in", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("matches with fingerprint-only payload when user enrolled both modalities", async () => {
    const user = await seedDualModalUser(newTrustId(), 10, 20);

    const fusion = await matchMultiModalFusion({
      payload: {
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          embedding: fpEmbedding(20.001),
        },
      },
    });

    expect(fusion.matched).toBe(true);
    expect(fusion.userId).toBe(user.id);
    expect(fusion.isFingerprintMatched).toBe(true);
    expect(fusion.isFaceMatched).toBe(false);
    expect(fusion.matchedModality).toBe("fingerprint");
    expect(fusion.fingerprintMatchScore).toBeGreaterThanOrEqual(
      BIOMETRIC_SINGLE_MODALITY_THRESHOLD,
    );
    expect(fusion.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.UNIVERSAL);
  });

  it("matches with face-only payload when user enrolled both modalities", async () => {
    const user = await seedDualModalUser(newTrustId(), 10, 20);

    const fusion = await matchMultiModalFusion({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          embedding: faceEmbedding(10.001),
        },
      },
    });

    expect(fusion.matched).toBe(true);
    expect(fusion.userId).toBe(user.id);
    expect(fusion.isFaceMatched).toBe(true);
    expect(fusion.isFingerprintMatched).toBe(false);
    expect(fusion.matchedModality).toBe("face");
    expect(fusion.faceMatchScore).toBeGreaterThanOrEqual(BIOMETRIC_SINGLE_MODALITY_THRESHOLD);
    expect(fusion.accessLevel).toBe(TRUST_ID_ACCESS_LEVELS.UNIVERSAL);
  });

  it("auto-enrolls and signs in on unknown single-modality biometric (zero-UI onboarding)", async () => {
    const result = await ambientSignInAndSession({
      payload: {
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
    expect(result.matchedModality).toBe("fingerprint");
  });

  it("POST /v1/trust-id/ambient-signin issues session from single modality", async () => {
    const user = await seedDualModalUser(newTrustId(), 5, 15);
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/trust-id/ambient-signin",
      payload: {
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          embedding: fpEmbedding(15.001),
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matched: boolean;
      trustId: string;
      matchedModality: string;
      isFingerprintMatched: boolean;
      isFaceMatched: boolean;
    };
    expect(body.matched).toBe(true);
    expect(body.trustId).toBe(user.trustId);
    expect(body.matchedModality).toBe("fingerprint");
    expect(body.isFingerprintMatched).toBe(true);
    expect(body.isFaceMatched).toBe(false);
    await app.close();
  });
});
