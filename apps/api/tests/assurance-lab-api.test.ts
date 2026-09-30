import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_PIPELINE_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
  BIOMETRIC_THRESHOLD_POLICY,
} from "@trustid/shared";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { ASSURANCE_LAB_PREFIX, findRawMediaField } from "../src/routes/assurance-lab.js";
import {
  productionDuplicateAssessor,
  productionIdentificationDecider,
} from "../src/modules/assurance-lab/service.js";
import { decideAfterRerank, exactRerankCandidates } from "../src/modules/trust-id/ann-rerank.js";

// Vectors here are SYNTHETIC fixtures posted into a throwaway temp store to
// exercise the lab API. They are never evidence of biometric accuracy.

const SECRET = "assurance-lab-test-secret-0123456789";
const P = ASSURANCE_LAB_PREFIX;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function unit(v: number[]) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
}
function identity(seed: number) {
  const r = rng(seed);
  return unit(Array.from({ length: BIOMETRIC_AI_EMBEDDING_DIMS }, () => gauss(r)));
}
function sample(base: number[], seed: number) {
  const r = rng(seed);
  return unit(base.map((x) => x + (0.4 / Math.sqrt(base.length)) * gauss(r)));
}

const MODEL = {
  name: BIOMETRIC_AI_MODEL_NAME,
  version: BIOMETRIC_AI_MODEL_VERSION,
  embeddingDimensions: BIOMETRIC_AI_EMBEDDING_DIMS,
  detectorVersion: BIOMETRIC_DETECTOR_VERSION,
  alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
  preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
  pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
  normalization: "L2",
  distanceMetric: "cosine_distance",
};
const WEB = {
  platform: "WEB",
  runtime: "CHROME",
  deviceClass: "LAPTOP_DESKTOP",
  cameraFacing: "USER",
  cameraOrientation: "LANDSCAPE",
  inferenceBackend: "WASM",
};
const ANDROID = { ...WEB, platform: "ANDROID", runtime: "ANDROID_WEBVIEW", deviceClass: "PHONE", cameraOrientation: "PORTRAIT" };

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

const ENV_KEYS = [
  "TRUSTID_ASSURANCE_LAB_ENABLED",
  "TRUSTID_ASSURANCE_LAB_SECRET",
  "TRUSTID_ASSURANCE_LAB_ROOT",
  "TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP",
  "NODE_ENV",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe("assurance lab API", () => {
  let app: FastifyInstance;
  let root: string;
  const headers = { "x-assurance-lab-secret": SECRET };

  const enable = () => {
    process.env.TRUSTID_ASSURANCE_LAB_ENABLED = "true";
    process.env.TRUSTID_ASSURANCE_LAB_SECRET = SECRET;
    process.env.TRUSTID_ASSURANCE_LAB_ROOT = root;
    process.env.TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP = "2";
    process.env.NODE_ENV = "test";
  };

  beforeAll(async () => {
    await resetTables(prisma);
    root = mkdtempSync(join(tmpdir(), "trustid-assurance-lab-"));
    enable();
    app = await buildApp();
  });

  afterEach(() => enable());

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await prisma.$disconnect();
  });

  const consent = async (phrase = "I CONSENT", cohort?: string) => {
    const doc = await app.inject({ method: "GET", url: `${P}/consent`, headers });
    return app.inject({
      method: "POST",
      url: `${P}/participants`,
      headers,
      payload: { phrase, consentVersion: doc.json().document.consentVersion, ...(cohort ? { cohort } : {}) },
    });
  };
  const startSession = async (participantId: string, protocolSessionKey: string, environment = WEB) =>
    app.inject({ method: "POST", url: `${P}/sessions`, headers, payload: { participantId, protocolSessionKey, environment } });
  const capture = async (sessionId: string, protocolStepKey: string, conditions: string[], embedding: number[] | null, extra = {}) =>
    app.inject({
      method: "POST",
      url: `${P}/captures`,
      headers,
      payload: {
        sessionId,
        protocolStepKey,
        conditions,
        model: MODEL,
        quality: { decision: embedding ? "PASS" : "REJECT" },
        pad: { decision: "PASS", method: "active_blink" },
        latencyMs: { embedding: 35, total: 110 },
        embedding,
        ...extra,
      },
    });

  it("is invisible (404) unless explicitly enabled with a secret outside production", async () => {
    delete process.env.TRUSTID_ASSURANCE_LAB_ENABLED;
    expect((await app.inject({ method: "GET", url: `${P}/status`, headers })).statusCode).toBe(404);
    enable();
    process.env.NODE_ENV = "production";
    expect((await app.inject({ method: "GET", url: `${P}/status`, headers })).statusCode).toBe(404);
    enable();
    process.env.TRUSTID_ASSURANCE_LAB_SECRET = "short";
    expect((await app.inject({ method: "GET", url: `${P}/status`, headers })).statusCode).toBe(404);
    enable();
    const wrong = await app.inject({ method: "GET", url: `${P}/status`, headers: { "x-assurance-lab-secret": "x".repeat(40) } });
    expect(wrong.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `${P}/status` })).statusCode).toBe(401);
  });

  it("status separates read-only production configuration from the lab", async () => {
    const res = await app.inject({ method: "GET", url: `${P}/status`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-trustid-result-kind"]).toBe("EVALUATION_RESULT");
    const body = res.json();
    expect(body.resultKind).toBe("EVALUATION_RESULT");
    expect(body.productionConfiguration.thresholdDistance).toBe(0.35);
    expect(body.productionConfiguration.writableFromLab).toBe(false);
    expect(Object.values(body.authorityBoundary).every((v) => v === false)).toBe(true);
    expect(body.lab.rawImagePolicy).toBe("TRANSIENT_NOT_RETAINED");
    expect(body.lab.protocol.flatMap((s: { steps: Array<{ targetCaptures: number }> }) => s.steps).every((s: { targetCaptures: number }) => s.targetCaptures === 2)).toBe(true);
  });

  it("requires the exact consent phrase and issues only a pseudonymous lab id", async () => {
    for (const phrase of ["i consent", "I AGREE", ""]) {
      const res = await consent(phrase);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("CONSENT_PHRASE_REQUIRED");
    }
    const mismatch = await app.inject({ method: "POST", url: `${P}/participants`, headers, payload: { phrase: "I CONSENT", consentVersion: "v0" } });
    expect(mismatch.json().error).toBe("CONSENT_VERSION_MISMATCH");

    const ok = await consent();
    expect(ok.statusCode).toBe(201);
    expect(ok.headers["set-cookie"]).toBeUndefined();
    const p = ok.json().participant;
    expect(p.participantId).toMatch(/^lab_p_[a-f0-9]{24}$/);
    expect(p.consentVersion).toBe("trustid-assurance-lab-consent-v1");
    expect(p.studyVersion).toBe("1");
    expect(typeof p.consentedAt).toBe("string");
    const doc = await app.inject({ method: "GET", url: `${P}/consent`, headers });
    expect(p.consentDocumentSha256).toBe(doc.json().documentSha256);
    expect(JSON.stringify(ok.json())).not.toMatch(/"(trustId|userId|sessionToken|email|phone|name)":/);
  });

  it("refuses raw images and non-production-model captures; stores no image", async () => {
    const pid = (await consent()).json().participant.participantId;
    const sid = (await startSession(pid, "SESSION_A")).json().session.sessionId;
    const img = await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(1), 1), { imageBase64: "AAAA" });
    expect(img.statusCode).toBe(400);
    expect(img.json().error).toBe("RAW_MEDIA_NOT_ACCEPTED");
    const nested = await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(1), 1), { quality: { decision: "PASS", frame: "x" } });
    expect(nested.json().error).toBe("RAW_MEDIA_NOT_ACCEPTED");
    const model = await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(1), 1), { model: { ...MODEL, version: 999 } });
    expect(model.json().error).toBe("MODEL_MISMATCH");
    const cond = await capture(sid, "A_BASELINE", ["LOW_LIGHT"], sample(identity(1), 1));
    expect(cond.json().error).toBe("CONDITION_NOT_ALLOWED");
    const ok = await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(1), 1));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().capture.rawImageRetained).toBe(false);
    expect(ok.json().capture.provenance).toBe("REAL_HUMAN_CONSENTED");
    expect("embedding" in ok.json().capture).toBe(false);
    for (const f of allFiles(root)) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/imageBase64|data:image|"frame"/);
    }
    expect(findRawMediaField({ a: [{ b: { photo: 1 } }] })).toBe("$.a[0].b.photo");
    expect(findRawMediaField({ environment: WEB, embedding: [0.1] })).toBeNull();
  });

  it("runs a full study through production decision code without touching production data", async () => {
    const before = {
      users: await prisma.user.count(),
      embeddings: await prisma.biometricEmbedding.count(),
      sessions: await prisma.session.count(),
    };
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const pid = (await consent("I CONSENT", i === 3 ? "OPEN_SET_HOLDOUT" : "GALLERY")).json().participant.participantId;
      ids.push(pid);
      const base = identity(100 + i);
      const a = (await startSession(pid, "SESSION_A", WEB)).json().session.sessionId;
      for (let k = 0; k < 2; k++) expect((await capture(a, "A_BASELINE", ["NORMAL"], sample(base, 1000 * i + k))).statusCode).toBe(201);
      expect((await capture(a, "A_POSE", ["POSE_VARIATION"], null)).statusCode).toBe(201);
      const bRes = await startSession(pid, "SESSION_B", ANDROID as never);
      expect(bRes.json().protocolWarnings.length).toBeGreaterThan(0);
      const b = bRes.json().session.sessionId;
      for (let k = 0; k < 2; k++) expect((await capture(b, "B_BASELINE", ["REPEAT_BASELINE"], sample(base, 1000 * i + 10 + k))).statusCode).toBe(201);
      const pad = await app.inject({
        method: "POST",
        url: `${P}/pad-attempts`,
        headers,
        payload: { sessionId: b, presentation: "STATIC_PHOTO", padDecision: "REJECT", padMethod: "active_blink", challengeResult: "FAILED", qualityDecision: "PASS" },
      });
      expect(pad.statusCode).toBe(201);
      expect(pad.json().padAttempt.rawMediaRetained).toBe(false);
    }

    const res = await app.inject({ method: "GET", url: `${P}/report`, headers });
    expect(res.statusCode).toBe(200);
    const { report, productionConfiguration } = res.json();
    expect(productionConfiguration.thresholdDistance).toBe(0.35);
    expect(report.resultKind).toBe("EVALUATION_RESULT");
    expect(report.evidence.evidenceClass).toBe("REAL_HUMAN_CONSENTED");
    expect(report.evidence.failureToAcquire.count).toBeGreaterThanOrEqual(4);
    expect(report.evidence.platforms.WEB.captures).toBeGreaterThan(0);
    expect(report.evidence.platforms.ANDROID.captures).toBeGreaterThan(0);
    expect(report.recommendation.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.recommendation.appliesToProduction).toBe(false);
    expect(report.statuses.calibration).toBe("INSUFFICIENT_DATA");
    expect(report.identification.retrievalMode).toBe("EXACT_IN_MEMORY_TOPK");
    expect(report.identification.gallerySize).toBeGreaterThanOrEqual(3);
    expect(report.identification.closedSet.outcomes.CORRECT_IDENTITY).toBeGreaterThan(0);
    expect(report.identification.openSet.outcomes.FALSE_IDENTIFICATION ?? 0).toBe(0);
    expect(report.duplicateEnrollment.serviceUnavailableFailClosed).toBe(true);
    expect(report.pad.productionReady).toBe(false);
    expect(report.pad.status).toBe("INSUFFICIENT_DATA");
    const text = res.body;
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/"embedding":\s*\[/);

    expect(BIOMETRIC_THRESHOLD_POLICY.threshold).toBe(0.35);
    expect({
      users: await prisma.user.count(),
      embeddings: await prisma.biometricEmbedding.count(),
      sessions: await prisma.session.count(),
    }).toEqual(before);
  });

  it("exports deterministic aggregate evidence with no ids, vectors, or secrets", async () => {
    const a = await app.inject({ method: "GET", url: `${P}/export`, headers });
    const b = await app.inject({ method: "GET", url: `${P}/export`, headers });
    expect(a.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
    expect(a.body).not.toMatch(/lab_p_|lab_c_|lab_s_/);
    expect(a.body).not.toMatch(/"embedding"|"vector"|"trustId"|"userId"|PRIVATE KEY/);
    expect(a.body).not.toContain(SECRET);
    expect(JSON.parse(a.body).generatedFrom).toBe("AGGREGATE_ONLY");
  });

  it("withdrawal deletes the participant's evidence and blocks further collection", async () => {
    const pid = (await consent()).json().participant.participantId;
    const sid = (await startSession(pid, "SESSION_A")).json().session.sessionId;
    await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(7), 7));
    const w = await app.inject({ method: "POST", url: `${P}/participants/${pid}/withdraw`, headers });
    expect(w.statusCode).toBe(200);
    expect(w.json().withdrawal.deleted.captures).toBe(1);
    expect(w.json().withdrawal.deleted.sessions).toBe(1);
    const left = allFiles(root).filter((f) => f.includes(pid));
    expect(left.every((f) => /participant\.json$|withdrawal\.json$/.test(f))).toBe(true);
    expect(readFileSync(left.find((f) => f.endsWith("participant.json"))!, "utf8")).toContain("WITHDRAWN");
    expect((await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(7), 8))).statusCode).toBe(404);
    expect((await startSession(pid, "SESSION_B")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${P}/participants/lab_p_${"0".repeat(24)}/withdraw`, headers })).statusCode).toBe(404);
  });

  it("lab code never imports session, authority, database, or enrollment modules", () => {
    const files = [
      "../src/routes/assurance-lab.ts",
      "../src/modules/assurance-lab/service.ts",
      "../src/modules/assurance-lab/store.ts",
    ].map((f) => readFileSync(new URL(f, import.meta.url), "utf8"));
    for (const src of files) {
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec).not.toMatch(/sessions|authorization|authentication|digi-authority|db\/client|prisma|fusion|register|matcher|vector-matcher|cookie/);
      }
      expect(src).not.toMatch(/setCookie|sessionToken\s*[:=]/);
    }
  });

  it("lab code does not reach database, lock, or matcher modules transitively", () => {
    const srcRoot = new URL("../src/", import.meta.url);
    const seen = new Set<string>();
    const queue = ["routes/assurance-lab.ts", "modules/assurance-lab/service.ts", "modules/assurance-lab/store.ts"];
    while (queue.length) {
      const rel = queue.shift()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const src = readFileSync(new URL(rel, srcRoot), "utf8");
      for (const m of src.matchAll(/import\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"/g)) {
        if (m[1]) continue;
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
        const resolved = new URL(m[2]!.replace(/\.js$/, ".ts"), new URL(dir, srcRoot)).href.slice(srcRoot.href.length);
        queue.push(resolved);
      }
    }
    expect(seen.has("modules/trust-id/retrieval-policy.ts")).toBe(true);
    for (const file of seen) {
      expect(file).not.toMatch(
        /db\/client|lib\/pgvector|enrollment-serialization|enrollment-gate|vector-matcher|fast-vector-match|fusion|register|sessions|authentication|authorization|digi-authority/,
      );
    }
  });

  it("uses the production rerank/threshold/ambiguity and duplicate code paths", () => {
    const probe = identity(500);
    const near = sample(probe, 1);
    const far = identity(501);
    const candidates = [
      { galleryKey: "g_far", annDistance: 0.9, vector: far },
      { galleryKey: "g_near", annDistance: 0.1, vector: near },
    ];
    const lab = productionIdentificationDecider()(probe, candidates);
    const prod = decideAfterRerank(
      exactRerankCandidates(probe, candidates.map((c) => ({ embeddingId: c.galleryKey, userId: c.galleryKey, trustId: c.galleryKey, annDistance: c.annDistance, vector: c.vector }))),
      0.35,
      0.02,
    );
    expect(lab.decision).toBe("MATCH");
    expect(lab.matchedGalleryKey).toBe(prod.accepted!.userId);
    const twin = productionIdentificationDecider()(probe, [
      { galleryKey: "g_a", annDistance: 0, vector: near },
      { galleryKey: "g_b", annDistance: 0, vector: near },
    ]);
    expect(twin.decision).toBe("AMBIGUOUS");
    const assess = productionDuplicateAssessor();
    expect(assess(probe, { status: "unavailable", reason: "down" }).decision).toBe("SERVICE_UNAVAILABLE");
    expect(assess(probe, { status: "ok", candidates: [{ galleryKey: "g_far", annDistance: 0.9, vector: far }] }).decision).toBe("CLEAR");
    expect(assess(probe, { status: "ok", candidates }).decision).toBe("REVIEW_REQUIRED");
  });
});
