/**
 * Face enroll must reject legacy models and accept production ArcFace only.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { pgVectorMatcher } from "../src/modules/trust-id/vector-matcher.js";
import { biometricMatcher } from "../src/modules/trust-id/matcher.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";

function unit512(seed: number) {
  const v = Array.from({ length: BIOMETRIC_AI_EMBEDDING_DIMS }, (_, i) =>
    Math.sin(seed + i * 0.01),
  );
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function seedUser() {
  const trustId = newTrustId();
  const nameCommit = commitName("Reg", "Fix");
  return prisma.user.create({
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
}

describe("face enrollment ArcFace gate", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects spatial_fallback_v1 (legacy protection intact)", async () => {
    const user = await seedUser();
    await expect(
      pgVectorMatcher.enrollEmbedding({
        userId: user.id,
        trustId: user.trustId,
        biometric: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: unit512(1),
          modelName: "spatial_fallback_v1",
          modelVersion: 1,
        },
      }),
    ).rejects.toMatchObject({
      errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
    });
  });

  it("rejects missing modelName on face enroll", async () => {
    const user = await seedUser();
    await expect(
      pgVectorMatcher.enrollEmbedding({
        userId: user.id,
        trustId: user.trustId,
        biometric: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: unit512(2),
        },
      }),
    ).rejects.toMatchObject({
      errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
    });
  });

  it("persists production ArcFace face template", async () => {
    const user = await seedUser();
    const result = await biometricMatcher.enrollTemplate({
      userId: user.id,
      trustId: user.trustId,
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: unit512(3),
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: BIOMETRIC_AI_MODEL_VERSION,
      },
    });
    expect(result.embeddingId ?? result.templateId).toBeTruthy();
    const row = await prisma.biometricEmbedding.findFirst({
      where: { userId: user.id, modality: "face" },
    });
    expect(row?.modelName).toBe(BIOMETRIC_AI_MODEL_NAME);
    const envelope = JSON.parse(row!.embeddingJson) as { modelName: string };
    expect(envelope.modelName).toBe(BIOMETRIC_AI_MODEL_NAME);
  });
});
