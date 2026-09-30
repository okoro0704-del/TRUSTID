import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import {
  consentDocumentText,
  createExactInMemoryRetriever,
  evaluateAnnRecallGovernance,
} from "@trustid/sdk/assurance-lab";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { ASSURANCE_LAB_PREFIX } from "../src/routes/assurance-lab.js";
import {
  annGovernanceCohortFromStore,
  LAB_TOP_K,
  openStudy,
  productionDuplicateAssessor,
  productionIdentificationDecider,
} from "../src/modules/assurance-lab/service.js";

// DRY RUN. Every vector below is a SYNTHETIC fixture, posted into a throwaway
// temp root that is deleted afterwards. No person is involved and nothing here
// is evidence of biometric accuracy. The lab classifies evidence by collection
// path, so these synthetic captures are labelled REAL_HUMAN_CONSENTED by the
// server; that is exactly why a dry run must never target the real study root.

const SECRET = "readiness-dry-run-secret-0123456789abcdef";
const P = ASSURANCE_LAB_PREFIX;
const DAY = 86_400_000;

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
const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
const identity = (seed: number) => {
  const r = rng(seed);
  return unit(Array.from({ length: BIOMETRIC_AI_EMBEDDING_DIMS }, () => gauss(r)));
};
const sample = (base: number[], seed: number) => {
  const r = rng(seed);
  return unit(base.map((x) => x + (0.4 / Math.sqrt(base.length)) * gauss(r)));
};

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

const ENV_KEYS = [
  "TRUSTID_ASSURANCE_LAB_ENABLED",
  "TRUSTID_ASSURANCE_LAB_SECRET",
  "TRUSTID_ASSURANCE_LAB_ROOT",
  "TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP",
  "TRUSTID_ASSURANCE_LAB_RETENTION_DAYS",
  "TRUSTID_ASSURANCE_LAB_STUDY_ID",
  "NODE_ENV",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

describe("real-human readiness DRY RUN (synthetic evidence only, throwaway store)", () => {
  let app: FastifyInstance;
  let root: string;
  const headers = { "x-assurance-lab-secret": SECRET };
  let productionBefore: Record<string, number>;
  const galleryIds: string[] = [];
  let holdoutId = "";
  let withdrawnId = "";

  const productionCounts = async () => ({
    users: await prisma.user.count(),
    embeddings: await prisma.biometricEmbedding.count(),
    sessions: await prisma.session.count(),
  });

  const consent = async (cohort: "GALLERY" | "OPEN_SET_HOLDOUT") => {
    const doc = await app.inject({ method: "GET", url: `${P}/consent`, headers });
    return app.inject({
      method: "POST",
      url: `${P}/participants`,
      headers,
      payload: { phrase: "I CONSENT", consentVersion: doc.json().document.consentVersion, cohort },
    });
  };
  const startSession = async (participantId: string, protocolSessionKey: string) =>
    (await app.inject({ method: "POST", url: `${P}/sessions`, headers, payload: { participantId, protocolSessionKey, environment: WEB } }))
      .json().session.sessionId as string;
  const capture = (sessionId: string, protocolStepKey: string, conditions: string[], embedding: number[], extra = {}) =>
    app.inject({
      method: "POST",
      url: `${P}/captures`,
      headers,
      payload: {
        sessionId,
        protocolStepKey,
        conditions,
        model: MODEL,
        quality: { decision: "PASS" },
        pad: { decision: "PASS", method: "active_blink" },
        latencyMs: { embedding: 35, total: 110 },
        embedding,
        ...extra,
      },
    });

  const enrol = async (cohort: "GALLERY" | "OPEN_SET_HOLDOUT", seed: number) => {
    const pid = (await consent(cohort)).json().participant.participantId as string;
    const base = identity(seed);
    const a = await startSession(pid, "SESSION_A");
    for (let k = 0; k < 2; k++) expect((await capture(a, "A_BASELINE", ["NORMAL"], sample(base, seed * 100 + k))).statusCode).toBe(201);
    const b = await startSession(pid, "SESSION_B");
    for (let k = 0; k < 2; k++) {
      expect((await capture(b, "B_BASELINE", ["REPEAT_BASELINE"], sample(base, seed * 100 + 10 + k))).statusCode).toBe(201);
    }
    return pid;
  };

  beforeAll(async () => {
    await resetTables(prisma);
    root = mkdtempSync(join(tmpdir(), "trustid-readiness-dry-run-"));
    process.env.TRUSTID_ASSURANCE_LAB_ENABLED = "true";
    process.env.TRUSTID_ASSURANCE_LAB_SECRET = SECRET;
    process.env.TRUSTID_ASSURANCE_LAB_ROOT = root;
    process.env.TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP = "2";
    delete process.env.TRUSTID_ASSURANCE_LAB_RETENTION_DAYS;
    delete process.env.TRUSTID_ASSURANCE_LAB_STUDY_ID;
    process.env.NODE_ENV = "test";
    app = await buildApp();
    productionBefore = await productionCounts();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await prisma.$disconnect();
  });

  it("consent: exact phrase, versioned document with 30-day retention, SHA-256 bound, pseudonymous id", async () => {
    const doc = (await app.inject({ method: "GET", url: `${P}/consent`, headers })).json();
    expect(doc.document.requiredPhrase).toBe("I CONSENT");
    expect(doc.document.consentVersion).toBe("trustid-assurance-lab-consent-v1");
    expect(doc.document.studyVersion).toBe("1");
    const retention = doc.document.sections.find((s: { heading: string }) => s.heading === "Retention");
    expect(retention.body).toContain("at most 30 days");
    expect(doc.document.sections.some((s: { heading: string }) => s.heading === "Withdrawal and deletion")).toBe(true);
    const recomputed = createHash("sha256").update(consentDocumentText(doc.document), "utf8").digest("hex");
    expect(doc.documentSha256).toBe(recomputed);

    const refused = await app.inject({
      method: "POST",
      url: `${P}/participants`,
      headers,
      payload: { phrase: "yes", consentVersion: doc.document.consentVersion },
    });
    expect(refused.json().error).toBe("CONSENT_PHRASE_REQUIRED");

    const ok = await consent("GALLERY");
    expect(ok.statusCode).toBe(201);
    const p = ok.json().participant;
    expect(p.participantId).toMatch(/^lab_p_[a-f0-9]{24}$/);
    expect(p.consentDocumentSha256).toBe(recomputed);
    expect(p.consentVersion).toBe(doc.document.consentVersion);
    expect(p.studyVersion).toBe("1");
    expect(JSON.stringify(p)).not.toMatch(/"(trustId|userId|email|phone|name|sessionToken)":/);
  });

  it("collection: server assigns REAL_HUMAN_CONSENTED; clients cannot choose provenance; raw media refused", async () => {
    for (let i = 0; i < 3; i++) galleryIds.push(await enrol("GALLERY", 300 + i));
    holdoutId = await enrol("OPEN_SET_HOLDOUT", 400);
    withdrawnId = await enrol("GALLERY", 500);

    const sid = await startSession(galleryIds[0]!, "SESSION_A");
    for (const provenance of ["SYNTHETIC_FIXTURE", "REAL_HUMAN_CONSENTED"]) {
      const forged = await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(300), 9), { provenance });
      expect(forged.statusCode).toBe(400);
    }
    const media = await capture(sid, "A_BASELINE", ["NORMAL"], sample(identity(300), 9), { imageBase64: "AAAA" });
    expect(media.json().error).toBe("RAW_MEDIA_NOT_ACCEPTED");

    const { store } = await openStudy();
    const records = store.listCaptures();
    expect(records.length).toBe(5 * 4);
    expect(records.every((c) => c.provenance === "REAL_HUMAN_CONSENTED" && c.rawImageRetained === false)).toBe(true);
    for (const f of allFiles(root)) expect(readFileSync(f, "utf8")).not.toMatch(/imageBase64|data:image|"frame"|"photo"/);
  });

  it("withdrawal removes the participant's evidence from the governance cohort", async () => {
    const w = await app.inject({ method: "POST", url: `${P}/participants/${withdrawnId}/withdraw`, headers });
    expect(w.statusCode).toBe(200);
    expect(w.json().withdrawal.deleted.captures).toBe(4);

    const { store, study } = await openStudy();
    expect(study.evidenceRetentionDays).toBe(30);
    const cohort = await annGovernanceCohortFromStore(store, study, new Date(Date.now() + 29 * DAY));
    expect(cohort.provenance).toBe("REAL_HUMAN_CONSENTED");
    expect(cohort.evidenceClass).toBe("REAL_HUMAN");
    expect(cohort.participants).toBe(5);
    const inCohort = new Set([...cohort.galleryCaptures, ...cohort.holdoutCaptures].map((c) => c.participantId));
    expect(inCohort.has(withdrawnId)).toBe(false);
    expect(inCohort).toEqual(new Set([...galleryIds, holdoutId]));
    expect(cohort.holdoutCaptures.every((c) => c.participantId === holdoutId)).toBe(true);
  });

  it("ANN governance runs on collected evidence through production decision code; output has no vectors or ids", async () => {
    const { store, study } = await openStudy();
    const cohort = await annGovernanceCohortFromStore(store, study, new Date(Date.now() + 29 * DAY));
    const report = await evaluateAnnRecallGovernance({
      evidenceClass: cohort.evidenceClass,
      galleryCaptures: cohort.galleryCaptures,
      holdoutCaptures: cohort.holdoutCaptures,
      configs: [{ label: "EXACT_CONTROL", efSearch: null, retrieverFactory: createExactInMemoryRetriever }],
      decide: productionIdentificationDecider(),
      assess: productionDuplicateAssessor(),
      thresholdDistance: BIOMETRIC_THRESHOLD_POLICY.threshold,
      topK: LAB_TOP_K,
      salt: "dry-run",
    });
    expect(report.labOnly).toBe(true);
    expect(report.productionChangeApplied).toBe(false);
    expect(report.thresholdDistance).toBe(0.35);
    expect(report.gallery.entries).toBe(3);
    expect(report.probes).toEqual({ mated: 6, nonMated: 4 });
    const exact = report.configs[0]!;
    expect(exact.retrieval.recallVsExactAtK.K_1).toBe(1);
    expect(exact.duplicateGate.returning.attempts).toBe(6);
    expect(exact.falseClear.trials).toBe(6);
    expect(report.falseClearHeadline[0]!.label).toBe("EXACT_CONTROL");

    const text = JSON.stringify(report);
    expect(text).not.toMatch(/"(embedding|vector)"\s*:/);
    for (const id of [...galleryIds, holdoutId, withdrawnId]) expect(text).not.toContain(id);
  });

  it("retention: evidence past 30 days is purged before any analysis", async () => {
    const { store, study } = await openStudy();
    const before = store.listCaptures().length;
    expect(before).toBe(16);
    const cohort = await annGovernanceCohortFromStore(store, study, new Date(Date.now() + 31 * DAY));
    expect(cohort.galleryCaptures).toHaveLength(0);
    expect(cohort.holdoutCaptures).toHaveLength(0);
    expect(store.listCaptures()).toHaveLength(0);
    expect(store.listParticipants().length).toBe(6);
  });

  it("production data and policy are untouched by the whole lifecycle", async () => {
    expect(await productionCounts()).toEqual(productionBefore);
    expect(BIOMETRIC_THRESHOLD_POLICY.threshold).toBe(0.35);
    expect(BIOMETRIC_THRESHOLD_POLICY.status).toBe("UNCALIBRATED");
  });
});
