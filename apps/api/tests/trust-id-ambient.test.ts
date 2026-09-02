import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIOMETRIC_MODALITIES,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
  TRUST_ID_ACCESS_LEVELS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { pgVectorMatcher } from "../src/modules/trust-id/vector-matcher.js";
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
    },
  });
  await pgVectorMatcher.enrollEmbedding({
    userId: user.id,
    trustId,
    biometric: {
      modality: BIOMETRIC_MODALITIES.FINGERPRINT,
      vector: aiVector512(fpSeed),
    },
  });
  return user;
}

describe("ambient AI 512-D pgvector sign-in", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("matches fingerprint-only 512-D vector when user enrolled both modalities", async () => {
    const user = await seedDualModalUser(newTrustId(), 10, 20);

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
    const user = await seedDualModalUser(newTrustId(), 10, 20);

    const fusion = await matchMultiModalFusion({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: aiVector512(10.001),
        },
      },
    });

    expect(fusion.matched).toBe(true);
    expect(fusion.userId).toBe(user.id);
    expect(fusion.isFaceMatched).toBe(true);
    expect(fusion.matchedModality).toBe("face");
  });

  it("auto-enrolls and signs in on unknown 512-D vector (zero-UI onboarding)", async () => {
    const result = await ambientSignInAndSession({
      payload: {
        fingerprint: {
          modality: BIOMETRIC_MODALITIES.FINGERPRINT,
          vector: aiVector512(888),
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
    const user = await seedDualModalUser(newTrustId(), 5, 15);
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
    await seedDualModalUser(newTrustId(), 1, 2);

    const fusion = await matchMultiModalFusion({
      payload: {
        face: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: aiVector512(9999),
        },
      },
    });

    expect(fusion.matched).toBe(false);
    expect(BIOMETRIC_PGVECTOR_MAX_DISTANCE).toBe(0.35);
  });
});
