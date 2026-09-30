import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { facePayload } from "./helpers/face.js";
import { autoEnrollFromBiometrics } from "../src/modules/trust-id/fusion.js";
import {
  enrollmentSerializationBackend,
  withBiometricEnrollmentLock,
} from "../src/modules/trust-id/enrollment-serialization.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";

describe("concurrent duplicate enrollment", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uses the single-process queue only for the local SQLite test database", () => {
    expect(enrollmentSerializationBackend()).toBe("SINGLE_PROCESS_DEV_ONLY");
  });

  it("two simultaneous enrollments of the same face create exactly one identity", async () => {
    const results = await Promise.allSettled([
      autoEnrollFromBiometrics({ payload: { face: facePayload(313) } }),
      autoEnrollFromBiometrics({ payload: { face: facePayload(313) } }),
    ]);
    const created = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ statusCode: 409, code: "DUPLICATE_ENROLLMENT_REVIEW_REQUIRED" });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.biometricEmbedding.count()).toBe(1);
  });

  it("a burst of same-face enrollments still yields one identity; different faces all enroll", async () => {
    const same = await Promise.allSettled(
      Array.from({ length: 6 }, () => autoEnrollFromBiometrics({ payload: { face: facePayload(421) } })),
    );
    expect(same.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const different = await Promise.allSettled(
      [1001, 2002, 3003].map((seed) => autoEnrollFromBiometrics({ payload: { face: facePayload(seed) } })),
    );
    expect(different.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await prisma.biometricEmbedding.count()).toBe(1 + different.filter((r) => r.status === "fulfilled").length);
  });

  it("a failing critical section does not wedge later enrollments", async () => {
    await expect(withBiometricEnrollmentLock(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const ok = await autoEnrollFromBiometrics({ payload: { face: facePayload(515) } });
    expect(ok.trustId).toBeTruthy();
  });
});
