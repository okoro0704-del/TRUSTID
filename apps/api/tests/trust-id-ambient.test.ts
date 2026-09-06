import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIOMETRIC_MODALITIES,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { pgVectorMatcher } from "../src/modules/trust-id/vector-matcher.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";
import {
  ambientSignInAndSession,
  matchMultiModalFusion,
} from "../src/modules/trust-id/fusion.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";

function aiVector512(seed: number): number[] {
  const v = Array.from({ length: BIOMETRIC_AI_EMBEDDING_DIMS }, (_, i) =>
    Math.sin(seed + i * 0.01),
  );
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
  await pgVectorMatcher.enrollEmbedding({
    userId: user.id,
    trustId,
    biometric: {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: aiVector512(faceSeed),
      modelName: BIOMETRIC_AI_MODEL_NAME,
      modelVersion: BIOMETRIC_AI_MODEL_VERSION,
    },
  });
  await pgVectorMatcher.enrollEmbedding({
    userId: user.id,
    trustId,
    biometric: {
      modality: BIOMETRIC_MODALITIES.FINGERPRINT,
      vector: aiVector512(fpSeed),
      modelName: "fingerprint_keystore_v1",
      modelVersion: 1,
    },
  });
  return user;
}

/** Without pgvector, 1:N relies on the (userId-keyed) hot cache — re-warm the modality under test. */
async function warmModalityHotCache(input: {
  userId: string;
  trustId: string;
  modality: "face" | "fingerprint";
  seed: number;
}) {
  if (input.modality === "face") {
    await pgVectorMatcher.enrollEmbedding({
      userId: input.userId,
      trustId: input.trustId,
      biometric: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: aiVector512(input.seed),
        modelName: BIOMETRIC_AI_MODEL_NAME,
        modelVersion: BIOMETRIC_AI_MODEL_VERSION,
      },
    });
    return;
  }
  await pgVectorMatcher.enrollEmbedding({
    userId: input.userId,
    trustId: input.trustId,
    biometric: {
      modality: BIOMETRIC_MODALITIES.FINGERPRINT,
      vector: aiVector512(input.seed),
      modelName: "fingerprint_keystore_v1",
      modelVersion: 1,
    },
  });
}

describe("ambient AI 512-D pgvector sign-in", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("matches fingerprint-only 512-D vector when user enrolled both modalities", async () => {
    const trustId = newTrustId();
    const user = await seedDualModalUser(trustId, 10, 20);
    await warmModalityHotCache({
      userId: user.id,
      trustId,
      modality: "fingerprint",
      seed: 20,
    });

    const fusion = await matchMultiModalFusion({
      payload: {
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          vector: aiVector512(20.001),
        },
      },
    });

    expect(fusion.matched).toBe(true);
    expect(fusion.userId).toBe(user.id);
    expect(fusion.isFingerprintMatched).toBe(true);
    expect(fusion.matchedModality).toBe("fingerprint");
  });

  it("matches face-only 512-D vector when user enrolled both modalities", async () => {
    const trustId = newTrustId();
    const user = await seedDualModalUser(trustId, 10, 20);
    await warmModalityHotCache({
      userId: user.id,
      trustId,
      modality: "face",
      seed: 10,
    });

    const fusion = await matchMultiModalFusion({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: aiVector512(10.001),
          modelName: BIOMETRIC_AI_MODEL_NAME,
          modelVersion: BIOMETRIC_AI_MODEL_VERSION,
        },
      },
    });

    expect(fusion.matched).toBe(true);
    expect(fusion.userId).toBe(user.id);
    expect(fusion.isFaceMatched).toBe(true);
    expect(fusion.matchedModality).toBe("face");
  });

  it("auto-enrolls and signs in on unknown ArcFace face vector (zero-UI onboarding)", async () => {
    const result = await ambientSignInAndSession({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: aiVector512(888),
          modelName: BIOMETRIC_AI_MODEL_NAME,
          modelVersion: BIOMETRIC_AI_MODEL_VERSION,
          confidence: 0.95,
        },
      },
      allowAutoEnroll: true,
    });

    expect(result.matched).toBe(true);
    expect(result.enrolled).toBe(true);
    expect(result.trustId).toMatch(/^TD-/);
    expect(result.sessionToken).toBeTruthy();
  });

  it("POST /v1/trust-id/ambient-signin issues session from 512-D vector", async () => {
    const trustId = newTrustId();
    const user = await seedDualModalUser(trustId, 5, 15);
    await warmModalityHotCache({
      userId: user.id,
      trustId,
      modality: "fingerprint",
      seed: 15,
    });
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/trust-id/ambient-signin",
      payload: {
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          vector: aiVector512(15.001),
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matched: boolean;
      trustId: string;
      matchedModality: string;
    };
    expect(body.matched).toBe(true);
    expect(body.trustId).toBe(user.trustId);
    expect(body.matchedModality).toBe("fingerprint");
    await app.close();
  });

  it("rejects vectors above pgvector distance threshold", async () => {
    const trustId = newTrustId();
    const user = await seedDualModalUser(trustId, 1, 2);
    // Warm face so the probe is scored against the face gallery, not the
    // fingerprint vector left in the userId-keyed hot cache.
    await warmModalityHotCache({
      userId: user.id,
      trustId,
      modality: "face",
      seed: 1,
    });

    const fusion = await matchMultiModalFusion({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: aiVector512(9999),
          modelName: BIOMETRIC_AI_MODEL_NAME,
        },
      },
    });

    expect(fusion.matched).toBe(false);
    expect(BIOMETRIC_PGVECTOR_MAX_DISTANCE).toBe(0.35);
  });
});
