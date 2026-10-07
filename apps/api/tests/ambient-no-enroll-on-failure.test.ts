/**
 * Zero-UI auto-enrolment may only follow a genuine "not enrolled" result.
 * An identification outage, a model/template mismatch or a gated threshold
 * must never mint a Trust ID (it would duplicate an existing person), and an
 * outage must never be reported to the client as a no-match.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  TRUST_ID_ACCESS_LEVELS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { ambientSignInAndSession } from "../src/modules/trust-id/fusion.js";
import { biometricMatcher } from "../src/modules/trust-id/matcher.js";
import { __clearHotVectorCacheForTests } from "../src/modules/trust-id/vector-hot-cache.js";

function aiVector512(seed: number): number[] {
  const v = Array.from({ length: BIOMETRIC_AI_EMBEDDING_DIMS }, (_, i) => Math.sin(seed + i * 0.01));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const face = () => ({
  modality: BIOMETRIC_MODALITIES.FACE,
  vector: aiVector512(321),
  modelName: BIOMETRIC_AI_MODEL_NAME,
  modelVersion: BIOMETRIC_AI_MODEL_VERSION,
  confidence: 0.95,
});

/** What the matcher returns for a given failure (shape of PgVectorMatcherService results). */
function matcherFails(errorCode: string) {
  return vi.spyOn(biometricMatcher, "matchOneToMany").mockResolvedValue({
    matched: false,
    accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
    isMasterDevice: false,
    errorCode,
    error: `simulated ${errorCode}`,
  } as never);
}

describe("auto-enrolment fails closed on non-genuine no-match", () => {
  beforeEach(async () => {
    await resetTables(prisma);
    __clearHotVectorCacheForTests();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.$disconnect();
  });

  for (const code of [
    BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE,
    BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_VERSION_MISMATCH,
    BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
    BIOMETRIC_ERROR_CODES.BIOMETRIC_THRESHOLD_UNCALIBRATED,
    BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
  ]) {
    it(`${code}: no Trust ID is created and the code is preserved`, async () => {
      matcherFails(code);
      const usersBefore = await prisma.user.count();
      const result = await ambientSignInAndSession({ payload: { face: face() }, allowAutoEnroll: true });
      expect(result.matched).toBe(false);
      expect((result as { enrolled?: boolean }).enrolled).not.toBe(true);
      expect((result as { errorCode?: string }).errorCode).toBe(code);
      expect(await prisma.user.count()).toBe(usersBefore);
    });
  }

  it("a genuine NO_MATCH still auto-enrols (existing zero-UI onboarding is unchanged)", async () => {
    matcherFails(BIOMETRIC_ERROR_CODES.NO_MATCH);
    const result = await ambientSignInAndSession({ payload: { face: face() }, allowAutoEnroll: true });
    expect(result.matched).toBe(true);
    expect((result as { enrolled?: boolean }).enrolled).toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });

  it("POST /v1/trust-id/ambient-signin: an outage is 503 BIOMETRIC_SERVICE_UNAVAILABLE, not a no-match, and creates nothing", async () => {
    matcherFails(BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/trust-id/ambient-signin", payload: { face: face() } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: "BIOMETRIC_SERVICE_UNAVAILABLE" });
    expect(res.json().error).not.toBe("ambient_no_match");
    expect(await prisma.user.count()).toBe(0);
    await app.close();
  });

  it("POST /v1/trust-id/ambient-signin: a genuine no-match without auto-enrol is 401 with errorCode NO_MATCH", async () => {
    matcherFails(BIOMETRIC_ERROR_CODES.NO_MATCH);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust-id/ambient-signin",
      payload: { face: face(), allowAutoEnroll: false },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "ambient_no_match", errorCode: "NO_MATCH" });
    expect(await prisma.user.count()).toBe(0);
    await app.close();
  });
});
