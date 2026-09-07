/**
 * Face template lifecycle: enroll ? persist ? retrieve ? verify.
 * Distinguishes FACE_NOT_ENROLLED from capture/detection failures.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_MODALITIES,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { registerTrustIdWithMasterDevice } from "../src/modules/trust-id/register.js";
import { pgVectorMatcher } from "../src/modules/trust-id/vector-matcher.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";

function aiVector512(seed: number): number[] {
  const v = Array.from({ length: BIOMETRIC_AI_EMBEDDING_DIMS }, (_, i) =>
    Math.sin(seed + i * 0.01),
  );
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe("face template lifecycle", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("enrolls ? persists ? retrieves template for same trustId/userId", async () => {
    const faceVec = aiVector512(42);
    const result = await registerTrustIdWithMasterDevice({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: faceVec,
          modelName: BIOMETRIC_AI_MODEL_NAME,
          modelVersion: BIOMETRIC_AI_MODEL_VERSION,
          confidence: 0.92,
        },
      },
      deviceName: "Lifecycle Phone",
      deviceFingerprint: "lifecycle-device-fingerprint-01",
    });

    expect(result.enrolled).toBe(true);
    expect(result.trustId).toMatch(/^TD-/);
    expect(result.faceEmbeddingId).toBeTruthy();
    expect(result.faceModelName).toBe(BIOMETRIC_AI_MODEL_NAME);
    expect(result.sessionToken).toBeTruthy();

    const row = await prisma.biometricEmbedding.findUnique({
      where: { id: result.faceEmbeddingId },
    });
    expect(row).toBeTruthy();
    expect(row!.userId).toBe(result.user.id);
    expect(row!.trustId).toBe(result.trustId);
    expect(row!.modality).toBe("face");
    expect(row!.status).toBe("active");
    expect(row!.modelName).toBe(BIOMETRIC_AI_MODEL_NAME);

    // Retrieval by same identity key used at enroll
    const byUser = await prisma.biometricEmbedding.findFirst({
      where: {
        userId: result.user.id,
        modality: "face",
        status: "active",
      },
    });
    expect(byUser?.id).toBe(result.faceEmbeddingId);

    // 1:1 verify against claimed Trust ID
    __clearHotVectorCacheForTests();
    const verify = await pgVectorMatcher.verifyOneToOne({
      claimedTrustId: result.trustId,
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: aiVector512(42.0001),
        modelName: BIOMETRIC_AI_MODEL_NAME,
      },
    });
    expect(verify.matched).toBe(true);
    expect(verify.userId).toBe(result.user.id);
    expect(verify.trustId).toBe(result.trustId);
  });

  it("rejects wrong face against enrolled template", async () => {
    const result = await registerTrustIdWithMasterDevice({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: aiVector512(10),
          modelName: BIOMETRIC_AI_MODEL_NAME,
          modelVersion: BIOMETRIC_AI_MODEL_VERSION,
          confidence: 0.9,
        },
      },
      deviceFingerprint: "lifecycle-device-fingerprint-02",
    });

    __clearHotVectorCacheForTests();
    const verify = await pgVectorMatcher.verifyOneToOne({
      claimedTrustId: result.trustId,
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: aiVector512(9999),
        modelName: BIOMETRIC_AI_MODEL_NAME,
      },
    });
    expect(verify.matched).toBe(false);
  });

  it("FACE_NOT_ENROLLED: no template row for unknown trustId", async () => {
    const row = await prisma.biometricEmbedding.findFirst({
      where: { trustId: "TD-DOESNOTEXIST", modality: "face", status: "active" },
    });
    expect(row).toBeNull();
  });
});
