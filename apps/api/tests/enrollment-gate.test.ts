import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";
import * as pgvector from "../src/lib/pgvector.js";
import { createSession } from "../src/modules/sessions/service.js";
import { biometricMatcher } from "../src/modules/trust-id/matcher.js";
import { pgVectorMatcher } from "../src/modules/trust-id/vector-matcher.js";
import { DUPLICATE_ENROLLMENT_DECISION } from "../src/modules/trust-id/duplicate-enrollment.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";
import { resetTables } from "./helpers/db.js";
import { face512, facePayload } from "./helpers/face.js";

const lockControl = vi.hoisted(() => ({ unavailable: false }));

vi.mock("../src/modules/trust-id/enrollment-serialization.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/trust-id/enrollment-serialization.js")>();
  return {
    ...actual,
    withBiometricEnrollmentLock: <T>(critical: () => Promise<T>, options?: object) =>
      lockControl.unavailable
        ? Promise.reject(actual.enrollmentLockUnavailableError())
        : actual.withBiometricEnrollmentLock(critical, options),
  };
});

/** Seeds are phase shifts of the same sinusoid; a quarter period apart is far beyond threshold. */
const HUMAN_A = 10;
const HUMAN_B = 10 + Math.PI / 2;
const HUMAN_C = 10 + Math.PI;

type App = Awaited<ReturnType<typeof buildApp>>;

async function seedIdentity(seed: number) {
  const trustId = newTrustId();
  const name = commitName("Seed", "Identity");
  const user = await prisma.user.create({
    data: {
      trustId,
      status: "active",
      profile: { create: { nameCommitment: name.nameCommitment, nameSalt: name.nameSalt } },
    },
  });
  await biometricMatcher.enrollTemplate({ userId: user.id, trustId, biometric: facePayload(seed) });
  const { token } = await createSession({ userId: user.id });
  return { user, trustId, token };
}

function registerTrustId(app: App, face: unknown) {
  const installId = randomUUID();
  return app.inject({
    method: "POST",
    url: "/v1/identity/register-trust-id",
    payload: { face, installId, deviceFingerprint: `hw-${installId}` },
  });
}

function ambientSignIn(app: App, face: unknown) {
  return app.inject({ method: "POST", url: "/v1/trust-id/ambient-signin", payload: { face } });
}

function enrollBiometric(app: App, token: string, biometric: unknown) {
  return app.inject({
    method: "POST",
    url: "/v1/trust-id/enroll-biometric",
    headers: { authorization: `Bearer ${token}` },
    payload: { biometric },
  });
}

/** Distinct identities whose enrolled face passes threshold for this probe. */
async function identitiesHolding(seed: number) {
  const assessment = await pgVectorMatcher.assessDuplicateEnrollment({ biometric: facePayload(seed) });
  return assessment.candidateTrustIds;
}

const legacyFace = {
  modality: BIOMETRIC_MODALITIES.FACE,
  embedding: Array.from({ length: 64 }, (_, i) => ((i % 7) + 1) / 10),
  confidence: 0.95,
};

describe("canonical enrollment gate", () => {
  let app: App;

  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
    lockControl.unavailable = false;
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("test faces are mutually far apart (fixture sanity)", async () => {
    await seedIdentity(HUMAN_A);
    expect(await identitiesHolding(HUMAN_A)).toHaveLength(1);
    expect(await identitiesHolding(HUMAN_B)).toHaveLength(0);
    expect(await identitiesHolding(HUMAN_C)).toHaveLength(0);
  });

  describe("entry validation (legacy bypass closed)", () => {
    it("register-trust-id refuses a legacy non-ArcFace face and creates nothing", async () => {
      const res = await registerTrustId(app, legacyFace);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("BIOMETRIC_TEMPLATE_LEGACY");
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.biometricTemplate.count()).toBe(0);
    });

    it("ambient-signin refuses to auto-enroll a legacy face", async () => {
      const res = await ambientSignIn(app, legacyFace);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await prisma.user.count()).toBe(0);
    });

    it("refuses a 512-D face without production model metadata", async () => {
      const res = await registerTrustId(app, {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: face512(HUMAN_A),
        confidence: 0.95,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("BIOMETRIC_TEMPLATE_LEGACY");
      expect(await prisma.user.count()).toBe(0);
    });

    it("refuses a wrong model version and a zero vector", async () => {
      const wrongVersion = await registerTrustId(app, facePayload(HUMAN_A, { modelVersion: 2 }));
      expect(wrongVersion.statusCode).toBe(400);
      expect(wrongVersion.json().error).toBe("BIOMETRIC_MODEL_VERSION_MISMATCH");
      const zero = await registerTrustId(app, facePayload(HUMAN_A, { vector: new Array(512).fill(0) }));
      expect(zero.statusCode).toBe(400);
      expect(zero.json().error).toBe("EMBEDDING_FAILED");
      expect(await prisma.user.count()).toBe(0);
    });

    it("refuses a low-confidence face capture", async () => {
      const res = await registerTrustId(app, facePayload(HUMAN_A, { confidence: 0.2 }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("NO_FACE");
      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe("POST /v1/trust-id/enroll-biometric", () => {
    it("refuses to attach a face that belongs to another identity", async () => {
      const owner = await seedIdentity(HUMAN_A);
      const other = await seedIdentity(HUMAN_B);
      const res = await enrollBiometric(app, other.token, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("DUPLICATE_ENROLLMENT_REVIEW_REQUIRED");
      expect(JSON.stringify(res.json())).not.toContain(owner.trustId);
      expect(await identitiesHolding(HUMAN_A)).toEqual([owner.trustId]);
      expect(await identitiesHolding(HUMAN_B)).toEqual([other.trustId]);
    });

    it("allows an identity to re-enroll its own face", async () => {
      const self = await seedIdentity(HUMAN_A);
      const res = await enrollBiometric(app, self.token, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(200);
      expect(await identitiesHolding(HUMAN_A)).toEqual([self.trustId]);
    });

    it("allows attaching a new face that no identity holds", async () => {
      const self = await seedIdentity(HUMAN_A);
      const res = await enrollBiometric(app, self.token, facePayload(HUMAN_C));
      expect(res.statusCode).toBe(200);
      expect(await identitiesHolding(HUMAN_C)).toEqual([self.trustId]);
    });

    it("refuses a legacy face on attach", async () => {
      const self = await seedIdentity(HUMAN_A);
      const res = await enrollBiometric(app, self.token, legacyFace);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("BIOMETRIC_TEMPLATE_LEGACY");
    });

    it("still accepts a device-key fingerprint template (not a human biometric)", async () => {
      const self = await seedIdentity(HUMAN_A);
      const res = await enrollBiometric(app, self.token, {
        modality: BIOMETRIC_MODALITIES.FINGERPRINT,
        vector: face512(77),
      });
      expect(res.statusCode).toBe(200);
    });

    it("requires a session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/trust-id/enroll-biometric",
        payload: { biometric: facePayload(HUMAN_A) },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("concurrency across production enrollment routes", () => {
    it("register-trust-id: 8 simultaneous same-face requests create exactly one identity", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => registerTrustId(app, facePayload(HUMAN_A))),
      );
      const ok = results.filter((r) => r.statusCode === 200);
      const blocked = results.filter((r) => r.statusCode === 409);
      expect(ok).toHaveLength(1);
      expect(blocked).toHaveLength(7);
      blocked.forEach((r) => expect(r.json().error).toBe("DUPLICATE_ENROLLMENT_REVIEW_REQUIRED"));
      expect(await prisma.user.count()).toBe(1);
      expect(await identitiesHolding(HUMAN_A)).toHaveLength(1);
    });

    it("ambient-signin: 8 simultaneous same-face requests create exactly one identity", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ambientSignIn(app, facePayload(HUMAN_A))),
      );
      expect(results.every((r) => r.statusCode < 500)).toBe(true);
      expect(await prisma.user.count()).toBe(1);
      expect(await identitiesHolding(HUMAN_A)).toHaveLength(1);
    });

    it("enroll-biometric: two identities racing to attach the same new face -> one holder", async () => {
      const x = await seedIdentity(HUMAN_B);
      const y = await seedIdentity(HUMAN_C);
      const results = await Promise.all([
        enrollBiometric(app, x.token, facePayload(HUMAN_A)),
        enrollBiometric(app, y.token, facePayload(HUMAN_A)),
        enrollBiometric(app, x.token, facePayload(HUMAN_A)),
        enrollBiometric(app, y.token, facePayload(HUMAN_A)),
      ]);
      expect(results.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);
      const holders = await identitiesHolding(HUMAN_A);
      expect(holders).toHaveLength(1);
      expect([x.trustId, y.trustId]).toContain(holders[0]);
    });

    it("mixed race (register + ambient + attach) on one face -> one identity holds it", async () => {
      const existing = await seedIdentity(HUMAN_B);
      const results = await Promise.all([
        registerTrustId(app, facePayload(HUMAN_A)),
        ambientSignIn(app, facePayload(HUMAN_A)),
        enrollBiometric(app, existing.token, facePayload(HUMAN_A)),
        registerTrustId(app, facePayload(HUMAN_A)),
        ambientSignIn(app, facePayload(HUMAN_A)),
        enrollBiometric(app, existing.token, facePayload(HUMAN_A)),
        registerTrustId(app, facePayload(HUMAN_A)),
        ambientSignIn(app, facePayload(HUMAN_A)),
      ]);
      expect(results.every((r) => r.statusCode < 500)).toBe(true);
      expect(await identitiesHolding(HUMAN_A)).toHaveLength(1);
      expect(await prisma.user.count()).toBeLessThanOrEqual(2);
    });
  });

  describe("fail closed", () => {
    it("ANN unavailable (pgvector off, gallery non-empty) -> 503, no identity", async () => {
      await seedIdentity(HUMAN_B);
      const prev = process.env.TRUSTID_SQLITE_ANN;
      delete process.env.TRUSTID_SQLITE_ANN;
      vi.spyOn(pgvector, "isPgVectorEnabled").mockResolvedValue(false);
      try {
        const res = await registerTrustId(app, facePayload(HUMAN_A));
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("BIOMETRIC_SERVICE_UNAVAILABLE");
        const attach = await ambientSignIn(app, facePayload(HUMAN_A));
        expect(attach.statusCode).not.toBe(200);
      } finally {
        if (prev != null) process.env.TRUSTID_SQLITE_ANN = prev;
      }
      expect(await prisma.user.count()).toBe(1);
    });

    it("ANN query throws -> 503 (never CLEAR), no identity", async () => {
      vi.spyOn(pgVectorMatcher, "assessDuplicateEnrollment").mockRejectedValue(new Error("connection reset"));
      const res = await registerTrustId(app, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("BIOMETRIC_SERVICE_UNAVAILABLE");
      expect(await prisma.user.count()).toBe(0);
    });

    it("SERVICE_UNAVAILABLE decision -> 503 on create and attach", async () => {
      const self = await seedIdentity(HUMAN_B);
      vi.spyOn(pgVectorMatcher, "assessDuplicateEnrollment").mockResolvedValue({
        decision: DUPLICATE_ENROLLMENT_DECISION.SERVICE_UNAVAILABLE,
        canAutoCreate: false,
        candidateCount: 0,
        candidateTrustIds: [],
        reason: "ann_query_failed",
      });
      expect((await registerTrustId(app, facePayload(HUMAN_A))).statusCode).toBe(503);
      expect((await enrollBiometric(app, self.token, facePayload(HUMAN_A))).statusCode).toBe(503);
      vi.restoreAllMocks();
      expect(await prisma.user.count()).toBe(1);
      expect(await identitiesHolding(HUMAN_A)).toHaveLength(0);
    });

    it("AMBIGUOUS decision -> 409 AMBIGUOUS_MATCH, no identity, candidates not disclosed", async () => {
      vi.spyOn(pgVectorMatcher, "assessDuplicateEnrollment").mockResolvedValue({
        decision: DUPLICATE_ENROLLMENT_DECISION.AMBIGUOUS,
        canAutoCreate: false,
        candidateCount: 2,
        candidateTrustIds: ["TD-SECRET-ONE", "TD-SECRET-TWO"],
        reason: "multiple_identities_within_ambiguity_margin",
      });
      const res = await registerTrustId(app, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("AMBIGUOUS_MATCH");
      expect(res.body).not.toContain("TD-SECRET");
      expect(await prisma.user.count()).toBe(0);
    });

    it("REVIEW_REQUIRED decision -> 409, no identity", async () => {
      vi.spyOn(pgVectorMatcher, "assessDuplicateEnrollment").mockResolvedValue({
        decision: DUPLICATE_ENROLLMENT_DECISION.REVIEW_REQUIRED,
        canAutoCreate: false,
        candidateCount: 1,
        candidateTrustIds: ["TD-SECRET-ONE"],
        reason: "existing_identity_passed_threshold",
      });
      const res = await registerTrustId(app, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("DUPLICATE_ENROLLMENT_REVIEW_REQUIRED");
      expect(res.body).not.toContain("TD-SECRET");
      expect(await prisma.user.count()).toBe(0);
    });

    it("an attach review naming the enrolling identity plus another still blocks", async () => {
      const self = await seedIdentity(HUMAN_B);
      vi.spyOn(pgVectorMatcher, "assessDuplicateEnrollment").mockResolvedValue({
        decision: DUPLICATE_ENROLLMENT_DECISION.REVIEW_REQUIRED,
        canAutoCreate: false,
        candidateCount: 2,
        candidateTrustIds: [self.trustId, "TD-OTHER"],
        reason: "existing_identity_passed_threshold",
      });
      const res = await enrollBiometric(app, self.token, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(409);
      vi.restoreAllMocks();
      expect(await identitiesHolding(HUMAN_A)).toHaveLength(0);
    });

    it("database unavailable during identity creation -> 503, no identity", async () => {
      // Prisma model delegates do not survive vi.spyOn restore; swap and put back by hand.
      const users = prisma.user as unknown as { create: unknown };
      const original = users.create;
      users.create = async () => {
        throw new Error("Can't reach database server");
      };
      try {
        const res = await registerTrustId(app, facePayload(HUMAN_A));
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("BIOMETRIC_SERVICE_UNAVAILABLE");
      } finally {
        users.create = original;
      }
      expect(await prisma.user.count()).toBe(0);
    });

    it("template write failure removes the new identity (no orphan) -> 503", async () => {
      vi.spyOn(biometricMatcher, "enrollTemplate").mockRejectedValue(new Error("disk I/O error"));
      const res = await registerTrustId(app, facePayload(HUMAN_A));
      expect(res.statusCode).toBe(503);
      vi.restoreAllMocks();
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.biometricEmbedding.count()).toBe(0);
    });

    it("enrollment lock unavailable -> 503 on create and attach, nothing written", async () => {
      const self = await seedIdentity(HUMAN_B);
      lockControl.unavailable = true;
      const create = await registerTrustId(app, facePayload(HUMAN_A));
      expect(create.statusCode).toBe(503);
      expect(create.json().error).toBe("BIOMETRIC_SERVICE_UNAVAILABLE");
      const attach = await enrollBiometric(app, self.token, facePayload(HUMAN_A));
      expect(attach.statusCode).toBe(503);
      lockControl.unavailable = false;
      expect(await prisma.user.count()).toBe(1);
      expect(await identitiesHolding(HUMAN_A)).toHaveLength(0);
    });
  });
});
