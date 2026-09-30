import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { productionConfigurationSnapshot } from "../src/modules/assurance-lab/service.js";
import {
  ANN_SESSION_SETTING_APPLICATION,
  biometricRetrievalPolicy,
} from "../src/modules/trust-id/retrieval-policy.js";

const ENV_KEYS = [
  "BIOMETRIC_ANN_TOP_K",
  "BIOMETRIC_HNSW_EF_SEARCH",
  "BIOMETRIC_ANN_QUERY_TIMEOUT_MS",
  "FAST_VECTOR_MAX_DISTANCE",
  "BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD",
  "EVAL_BIOMETRIC_SECRET",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("biometric retrieval policy (governance, read-only)", () => {
  afterEach(restoreEnv);

  it("declares the production policy explicitly", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const p = biometricRetrievalPolicy();
    expect(p.readOnly).toBe(true);
    expect(p.containsBiometricData).toBe(false);
    expect(p.model).toEqual({
      name: "insightface_arcface_w600k_mbf_v1",
      version: 1,
      dimensions: 512,
      normalization: "L2",
      metric: "cosine_distance",
    });
    expect(p.index).toEqual({ type: "hnsw", m: 16, efConstruction: 64, opclass: "vector_cosine_ops" });
    expect(p.topK).toMatchObject({ declaredDefault: 50, effective: 50, override: { present: false } });
    expect(p.efSearch).toMatchObject({ declaredDefault: 64, declaredEffective: 64, override: { present: false } });
    expect(p.annQueryTimeoutMs).toMatchObject({ declaredDefault: 2000, declaredEffective: 2000 });
    expect(p.threshold).toMatchObject({
      policyDistance: 0.35,
      effectiveDistance: 0.35,
      status: "UNCALIBRATED",
      requireCalibrated: false,
    });
    expect(p.ambiguityMarginDistance).toBe(0.02);
    expect(p.duplicateGate.onlyClearCreates).toBe(true);
    expect(p.governance.writableFromThisSurface).toBe(false);
  });

  it("reports environment overrides the same way the matcher resolves them", () => {
    process.env.BIOMETRIC_ANN_TOP_K = "100";
    process.env.BIOMETRIC_HNSW_EF_SEARCH = "40";
    process.env.BIOMETRIC_ANN_QUERY_TIMEOUT_MS = "750";
    process.env.FAST_VECTOR_MAX_DISTANCE = "0.3";
    const p = biometricRetrievalPolicy();
    expect(p.topK).toMatchObject({ effective: 100, override: { present: true } });
    expect(p.efSearch.declaredEffective).toBe(100);
    expect(p.annQueryTimeoutMs.declaredEffective).toBe(750);
    expect(p.threshold).toMatchObject({ policyDistance: 0.35, effectiveDistance: 0.3, override: { present: true } });

    process.env.BIOMETRIC_ANN_TOP_K = "10";
    process.env.BIOMETRIC_HNSW_EF_SEARCH = "not-a-number";
    expect(biometricRetrievalPolicy().efSearch.declaredEffective).toBe(64);
  });

  it("drift guard: resolution rules still match vector-matcher.ts", () => {
    const vm = source("../src/modules/trust-id/vector-matcher.ts");
    expect(vm).toContain("return Math.max(BIOMETRIC_HNSW_EF_SEARCH_DEFAULT, topK);");
    expect(vm).toContain("if (Number.isFinite(n) && n > 0) return Math.max(n, topK);");
    expect(vm).toContain("return BIOMETRIC_ANN_QUERY_TIMEOUT_MS;");
    expect(vm).toContain("return BIOMETRIC_THRESHOLD_POLICY.threshold;");
    const pg = source("../src/lib/pgvector.ts");
    expect(pg).toContain("USING hnsw (vector vector_cosine_ops)");
    expect(pg).toContain("WITH (m = 16, ef_construction = 64)");
  });

  it("drift guard: session settings are still issued outside a transaction (finding stands)", () => {
    const vm = source("../src/modules/trust-id/vector-matcher.ts");
    const start = vm.indexOf("private async fetchAnnTopK(");
    const body = vm.slice(start, vm.indexOf("\n  }\n", start));
    expect(body).toContain("SET LOCAL statement_timeout");
    expect(body).toContain("set_config('hnsw.ef_search'");
    // If this starts failing, the query path changed: re-measure and update
    // ANN_SESSION_SETTING_APPLICATION before reporting ef_search as applied.
    expect(body).not.toContain("$transaction");
    expect(ANN_SESSION_SETTING_APPLICATION.status).toBe("NOT_APPLIED_OUTSIDE_TRANSACTION");
  });

  it("Assurance Lab production snapshot carries the policy and stays read-only", () => {
    const snap = productionConfigurationSnapshot();
    expect(snap.writableFromLab).toBe(false);
    expect(snap.retrievalPolicy.efSearch.application.status).toBe("NOT_APPLIED_OUTSIDE_TRANSACTION");
    expect(snap.retrievalPolicy.threshold.policyDistance).toBe(0.35);
  });
});

describe("GET /internal/biometric-governance/retrieval-policy", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    restoreEnv();
    await app.close();
  });

  afterEach(restoreEnv);

  const url = "/internal/biometric-governance/retrieval-policy";

  it("is not exposed when the internal secret is not configured", async () => {
    delete process.env.EVAL_BIOMETRIC_SECRET;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a wrong secret", async () => {
    process.env.EVAL_BIOMETRIC_SECRET = "governance-test-secret-0123456789";
    const res = await app.inject({ method: "GET", url, headers: { "x-eval-biometric-secret": "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns the policy, no biometric data, and cannot be written", async () => {
    process.env.EVAL_BIOMETRIC_SECRET = "governance-test-secret-0123456789";
    const headers = { "x-eval-biometric-secret": "governance-test-secret-0123456789" };
    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.schemaVersion).toBe("trustid_biometric_retrieval_policy_v1");
    expect(body.efSearch.declaredEffective).toBe(64);
    expect(body.database).toEqual({ observed: false, reason: "pgvector_not_enabled" });
    expect(res.body).not.toMatch(/"(vector|embedding|embeddingJson|trustId|userId)"\s*:/);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const w = await app.inject({ method, url, headers, payload: { efSearch: { declaredEffective: 512 } } });
      expect(w.statusCode).toBe(404);
    }
    expect(biometricRetrievalPolicy().efSearch.declaredEffective).toBe(64);
  });
});
