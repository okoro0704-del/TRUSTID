import { describe, expect, it } from "vitest";
import { BIOMETRIC_THRESHOLD_POLICY } from "@trustid/shared";
import { computeVerificationReportFromScores } from "../src/capture/biometric/benchmark/metrics.js";
import {
  analyzeLabStudy,
  assertExportPrivacy,
  assertLabResponseIsolation,
  assertSingleEvidenceClass,
  buildAssuranceExport,
  buildConsentDocument,
  buildDevelopmentStudyConfig,
  buildLabCaptureRecord,
  buildLabGallery,
  comparableCaptures,
  computePadReport,
  countCrossParticipantPairs,
  createExactInMemoryRetriever,
  deriveSweepGrid,
  evaluateAnnRecallGovernance,
  evaluateDuplicateEnrollment,
  evaluateIdentification,
  expectedPadDecision,
  falseClearMetric,
  forEachImpostorPair,
  generateGenuinePairs,
  LAB_AUTHORITY_BOUNDARY,
  LAB_CONSENT_PHRASE,
  LAB_CONSENT_VERSION,
  LAB_PRODUCTION_MODEL,
  LabEvidenceError,
  recommendThreshold,
  summarizeRoc,
  thresholdSweep,
  toCaptureEvidence,
  validateConsentAcceptance,
  validateStudyConfig,
  type AnnGovernanceConfig,
  type ComparableCapture,
  type LabCaptureRecord,
  type LabGalleryEntry,
  type LabRetriever,
  type LabDuplicateAssessor,
  type LabEnvironment,
  type LabEvidenceProvenance,
  type LabIdentificationDecider,
  type LabPadAttempt,
  type LabParticipant,
  type LabSession,
  type LabStudyConfig,
} from "../src/capture/biometric/assurance-lab/index.js";

// All vectors below are SYNTHETIC test fixtures. They exercise lab plumbing and
// gate logic only; no test here is evidence of biometric accuracy.

const PROD = BIOMETRIC_THRESHOLD_POLICY.threshold;
const MARGIN = 0.02;
const DIMS = LAB_PRODUCTION_MODEL.embeddingDimensions;

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

function gauss(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function unit(v: number[]) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function randomUnit(r: () => number) {
  return unit(Array.from({ length: DIMS }, () => gauss(r)));
}

function jitter(base: number[], sigma: number, r: () => number) {
  const k = sigma / Math.sqrt(DIMS);
  return unit(base.map((x) => x + k * gauss(r)));
}

const WEB_CHROME: LabEnvironment = {
  platform: "WEB",
  runtime: "CHROME",
  deviceClass: "LAPTOP_DESKTOP",
  cameraFacing: "USER",
  cameraOrientation: "LANDSCAPE",
  inferenceBackend: "WASM",
};
const ANDROID_WEBVIEW: LabEnvironment = {
  platform: "ANDROID",
  runtime: "ANDROID_WEBVIEW",
  deviceClass: "PHONE",
  cameraFacing: "USER",
  cameraOrientation: "PORTRAIT",
  inferenceBackend: "WASM",
};

function study(capturesPerStep = 2): LabStudyConfig {
  return buildDevelopmentStudyConfig({
    studyId: "lab_test_study",
    capturesPerStep,
    sampleSizeRationale: "unit-test fixture",
    evidenceRetentionDays: 30,
    consentVersion: LAB_CONSENT_VERSION,
    studyVersion: "v1",
  });
}

function participant(id: string, cohort: LabParticipant["cohort"] = "GALLERY"): LabParticipant {
  return {
    participantId: id,
    studyId: "lab_test_study",
    studyVersion: "v1",
    consentVersion: LAB_CONSENT_VERSION,
    consentedAt: "2026-09-01T00:00:00.000Z",
    cohort,
    createdAt: "2026-09-01T00:00:00.000Z",
    status: "ACTIVE",
  };
}

function session(participantId: string, key: string, env: LabEnvironment, day: number): LabSession {
  return {
    sessionId: `${participantId}_${key}`,
    studyId: "lab_test_study",
    participantId,
    protocolSessionKey: key,
    startedAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    environment: env,
  };
}

type Fixture = {
  cfg: LabStudyConfig;
  participants: LabParticipant[];
  sessions: LabSession[];
  captures: LabCaptureRecord[];
};

/** Synthetic cohort: each participant has sessions A (web) and B (android). */
function fixture(opts: {
  gallery: number;
  holdout?: number;
  perStep?: number;
  sigma?: number;
  provenance?: LabEvidenceProvenance;
  seed?: number;
}): Fixture {
  const cfg = study(opts.perStep ?? 2);
  const r = rng(opts.seed ?? 11);
  const provenance = opts.provenance ?? "SYNTHETIC";
  const participants: LabParticipant[] = [];
  const sessions: LabSession[] = [];
  const captures: LabCaptureRecord[] = [];
  const total = opts.gallery + (opts.holdout ?? 0);
  for (let p = 0; p < total; p++) {
    const id = `lab_p_${String(p).padStart(4, "0")}`;
    participants.push(participant(id, p < opts.gallery ? "GALLERY" : "OPEN_SET_HOLDOUT"));
    const base = randomUnit(r);
    const plan: Array<[string, LabEnvironment, number, Array<[string, string]>]> = [
      ["SESSION_A", WEB_CHROME, 2, [["A_BASELINE", "NORMAL"], ["A_POSE", "POSE_VARIATION"]]],
      ["SESSION_B", ANDROID_WEBVIEW, 4, [["B_BASELINE", "REPEAT_BASELINE"], ["B_LIGHTING", "LOW_LIGHT"]]],
    ];
    for (const [key, env, day, steps] of plan) {
      const s = session(id, key, env, day);
      sessions.push(s);
      let n = 0;
      for (const [step, cond] of steps) {
        for (let i = 0; i < (opts.perStep ?? 2); i++) {
          captures.push(
            buildLabCaptureRecord(cfg, s, {
              provenance,
              captureId: `${s.sessionId}_${step}_${i}`,
              capturedAt: `${s.startedAt.slice(0, 11)}00:00:${String(n++).padStart(2, "0")}.000Z`,
              protocolStepKey: step,
              conditions: [cond as never],
              model: { ...LAB_PRODUCTION_MODEL },
              quality: { decision: "PASS" },
              pad: { decision: "PASS", method: "blink" },
              latencyMs: { embedding: 40, total: 120 },
              embedding: jitter(base, opts.sigma ?? 0.4, r),
            }),
          );
        }
      }
    }
  }
  return { cfg, participants, sessions, captures };
}

/** Mirrors apps/api ann-rerank decideAfterRerank(threshold, margin) for SDK-only tests. */
function decider(threshold = PROD, margin = MARGIN): LabIdentificationDecider {
  return (probe, candidates) => {
    const ranked = candidates
      .map((c) => ({
        galleryKey: c.galleryKey,
        distance: c.vector ? 1 - c.vector.reduce((s, x, i) => s + x * probe[i]!, 0) : c.annDistance,
      }))
      .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (!best || best.distance > threshold) return { ranked, decision: "NO_MATCH" };
    const competing = ranked.find((c) => c.galleryKey !== best.galleryKey);
    if (competing && competing.distance <= threshold && competing.distance - best.distance <= margin) {
      return { ranked, decision: "AMBIGUOUS" };
    }
    return { ranked, decision: "MATCH", matchedGalleryKey: best.galleryKey };
  };
}

const assessor: LabDuplicateAssessor = (probe, retrieval) => {
  if (retrieval.status === "unavailable") return { decision: "SERVICE_UNAVAILABLE" };
  const d = decider()(probe, retrieval.candidates);
  const passing = d.ranked.filter((c) => c.distance <= PROD);
  if (!passing.length) return { decision: "CLEAR" };
  return { decision: d.decision === "AMBIGUOUS" ? "AMBIGUOUS" : "REVIEW_REQUIRED" };
};

async function analyze(f: Fixture, padAttempts: LabPadAttempt[] = []) {
  return analyzeLabStudy({
    study: f.cfg,
    participants: f.participants,
    sessions: f.sessions,
    captures: f.captures,
    padAttempts,
    retrieverFactory: createExactInMemoryRetriever,
    decide: decider(),
    assessDuplicate: assessor,
    topK: 10,
    now: () => new Date("2026-09-29T00:00:00.000Z"),
  });
}

describe("assurance lab: protocol and consent", () => {
  it("builds a configurable A/B/C protocol with no hardcoded capture count", () => {
    const small = study(1);
    const large = study(9);
    expect(validateStudyConfig(small)).toEqual([]);
    expect(small.sessions.map((s) => s.key)).toEqual(["SESSION_A", "SESSION_B", "SESSION_C"]);
    expect(small.sessions.flatMap((s) => s.steps).every((s) => s.targetCaptures === 1)).toBe(true);
    expect(large.sessions.flatMap((s) => s.steps).every((s) => s.targetCaptures === 9)).toBe(true);
    expect(small.rawImagePolicy).toBe("TRANSIENT_NOT_RETAINED");
  });

  it("rejects raw image retention and invalid protocol config", () => {
    const bad = { ...study(), rawImagePolicy: "RETAIN" as never, evidenceRetentionDays: 0, sampleSizeRationale: " " };
    const errors = validateStudyConfig(bad);
    expect(errors.some((e) => e.includes("raw image"))).toBe(true);
    expect(errors.some((e) => e.includes("evidenceRetentionDays"))).toBe(true);
    expect(errors.some((e) => e.includes("sampleSizeRationale"))).toBe(true);
  });

  it("requires the exact phrase I CONSENT for the consent version shown", () => {
    const doc = buildConsentDocument(study());
    expect(doc.requiredPhrase).toBe("I CONSENT");
    expect(validateConsentAcceptance({ phrase: LAB_CONSENT_PHRASE, consentVersion: doc.consentVersion }, doc)).toEqual({
      ok: true,
    });
    for (const phrase of ["i consent", "I AGREE", "", "yes", undefined, "I CONSENT!"]) {
      expect(validateConsentAcceptance({ phrase, consentVersion: doc.consentVersion }, doc)).toEqual({
        ok: false,
        reason: "CONSENT_PHRASE_REQUIRED",
      });
    }
    expect(validateConsentAcceptance({ phrase: "I CONSENT", consentVersion: "old" }, doc)).toEqual({
      ok: false,
      reason: "CONSENT_VERSION_MISMATCH",
    });
  });

  it("consent text discloses purpose, non-retention of images, retention, and withdrawal", () => {
    const text = JSON.stringify(buildConsentDocument(study()));
    expect(text).toContain("does not create a TrustID");
    expect(text).toContain("not uploaded or stored");
    expect(text).toContain("30 days");
    expect(text).toContain("withdraw");
    expect(text).toContain("random study ID");
  });
});

describe("assurance lab: evidence classification and provenance", () => {
  const cfg = study();
  const s = session("lab_p_x", "SESSION_A", WEB_CHROME, 2);
  const base = {
    provenance: "REAL_HUMAN_CONSENTED" as const,
    captureId: "c1",
    capturedAt: "2026-09-02T00:00:00.000Z",
    protocolStepKey: "A_BASELINE",
    conditions: ["NORMAL" as const],
    model: { ...LAB_PRODUCTION_MODEL },
    quality: { decision: "PASS" as const },
    pad: { decision: "PASS" as const },
    latencyMs: { total: 100 },
    embedding: randomUnit(rng(1)),
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as LabEvidenceError).code;
    }
    return "NO_ERROR";
  };

  it("records production-pipeline captures with no raw image and strips embeddings from evidence", () => {
    const rec = buildLabCaptureRecord(cfg, s, base);
    expect(rec.rawImageRetained).toBe(false);
    expect(rec.resultKind).toBe("EVALUATION_RESULT");
    expect(rec.conditionSource).toBe("OPERATOR_LABEL");
    expect(rec.model).toEqual(LAB_PRODUCTION_MODEL);
    const ev = toCaptureEvidence(rec);
    expect("embedding" in ev).toBe(false);
  });

  it("rejects captures that are not the production model or not L2 embeddings", () => {
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, model: { ...base.model, version: 999 } }))).toBe(
      "MODEL_MISMATCH",
    );
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, model: { ...base.model, name: "other" } }))).toBe(
      "MODEL_MISMATCH",
    );
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, embedding: base.embedding.slice(0, 128) }))).toBe(
      "EMBEDDING_DIMENSIONS",
    );
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, embedding: base.embedding.map((x) => x * 2) }))).toBe(
      "EMBEDDING_NOT_L2_NORMALIZED",
    );
    expect(
      code(() => buildLabCaptureRecord(cfg, s, { ...base, embedding: [...base.embedding.slice(1), Number.NaN] })),
    ).toBe("EMBEDDING_NOT_FINITE");
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, embedding: null }))).toBe("EMBEDDING_REQUIRED");
    expect(
      code(() => buildLabCaptureRecord(cfg, s, { ...base, quality: { decision: "REJECT" } })),
    ).toBe("EMBEDDING_FORBIDDEN_ON_QUALITY_REJECT");
  });

  it("enforces protocol steps and operator-labelled conditions", () => {
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, protocolStepKey: "B_LIGHTING" }))).toBe(
      "UNKNOWN_PROTOCOL_STEP",
    );
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, conditions: ["LOW_LIGHT"] }))).toBe(
      "CONDITION_NOT_ALLOWED",
    );
    expect(code(() => buildLabCaptureRecord(cfg, s, { ...base, conditions: [] }))).toBe("CONDITIONS_REQUIRED");
  });

  it("never mixes REAL_HUMAN_CONSENTED and SYNTHETIC evidence", () => {
    expect(assertSingleEvidenceClass([{ provenance: "SYNTHETIC" }, { provenance: "SYNTHETIC" }])).toBe("SYNTHETIC");
    expect(code(() => assertSingleEvidenceClass([{ provenance: "SYNTHETIC" }, { provenance: "REAL_HUMAN_CONSENTED" }]))).toBe(
      "EVIDENCE_CLASSES_MIXED",
    );
  });

  it("analysis refuses mixed evidence classes", async () => {
    const real = fixture({ gallery: 2, provenance: "REAL_HUMAN_CONSENTED", seed: 3 });
    const syn = fixture({ gallery: 2, provenance: "SYNTHETIC", seed: 4 });
    syn.participants.forEach((p) => (p.participantId = p.participantId.replace("lab_p_", "lab_q_")));
    const mixed: Fixture = {
      cfg: real.cfg,
      participants: [...real.participants, ...syn.participants],
      sessions: real.sessions,
      captures: [
        ...real.captures,
        ...syn.captures.map((c) => ({ ...c, participantId: c.participantId.replace("lab_p_", "lab_q_") })),
      ],
    };
    await expect(analyze(mixed)).rejects.toThrow(/cannot be combined/);
  });
});

describe("assurance lab: genuine and impostor pairs", () => {
  it("uses every same-participant pair (no cherry-picking), including poor genuine captures", () => {
    const f = fixture({ gallery: 3, perStep: 2, seed: 5 });
    // Replace one capture with an unrelated vector: a terrible genuine sample must still be counted.
    f.captures[0] = { ...f.captures[0]!, embedding: randomUnit(rng(999)) };
    const comp = comparableCaptures(f.captures);
    const genuine = generateGenuinePairs(comp);
    const perParticipant = 8;
    expect(genuine.length).toBe(3 * ((perParticipant * (perParticipant - 1)) / 2));
    expect(genuine.every((p) => p.genuine && p.participantA === p.participantB)).toBe(true);
    expect(Math.max(...genuine.map((p) => p.distance))).toBeGreaterThan(0.8);
    expect(genuine.some((p) => !p.sameSession)).toBe(true);
    expect(genuine.some((p) => p.crossRuntimeOrDevice)).toBe(true);
  });

  it("enumerates impostors exhaustively under the cap", () => {
    const comp = comparableCaptures(fixture({ gallery: 4, perStep: 1, seed: 6 }).captures);
    const total = countCrossParticipantPairs(comp);
    expect(total).toBe((16 * 15) / 2 - 4 * ((4 * 3) / 2));
    let seen = 0;
    const summary = forEachImpostorPair(comp, { exhaustiveCap: 10_000, seed: 1 }, (p) => {
      expect(p.genuine).toBe(false);
      expect(p.participantA).not.toBe(p.participantB);
      seen++;
    });
    expect(summary.method).toBe("EXHAUSTIVE");
    expect(seen).toBe(total);
  });

  it("samples impostors deterministically by seed above the cap", () => {
    const comp = comparableCaptures(fixture({ gallery: 6, perStep: 1, seed: 7 }).captures);
    const run = (seed: number) => {
      const keys: string[] = [];
      const summary = forEachImpostorPair(comp, { exhaustiveCap: 50, seed }, (p) => keys.push(`${p.captureA}|${p.captureB}`));
      return { keys, summary };
    };
    const a = run(42);
    const b = run(42);
    const c = run(43);
    expect(a.summary.method).toBe("SEEDED_UNIFORM_WITHOUT_REPLACEMENT");
    expect(a.summary.evaluatedPairs).toBe(50);
    expect(a.keys).toEqual(b.keys);
    expect(a.keys).not.toEqual(c.keys);
    expect(new Set(a.keys).size).toBe(50);
  });
});

describe("assurance lab: threshold sweep, FMR/FNMR, ROC, EER", () => {
  it("computes FMR/FNMR/TAR/TRR with production distance <= threshold semantics", () => {
    const genuine = [0.1, 0.2, 0.3, 0.35, 0.4];
    const impostor = [0.3, 0.35, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1];
    const rows = thresholdSweep(genuine, impostor, [0.35]);
    const r = rows[0]!;
    expect(r.isProductionThreshold).toBe(true);
    expect(r.trueAccepts).toBe(4); // 0.35 is accepted (boundary inclusive)
    expect(r.falseRejects).toBe(1);
    expect(r.falseAccepts).toBe(2);
    expect(r.trueRejects).toBe(8);
    expect(r.fmr).toBeCloseTo(0.2, 12);
    expect(r.fnmr).toBeCloseTo(0.2, 12);
    expect(r.tar).toBeCloseTo(0.8, 12);
    expect(r.trr).toBeCloseTo(0.8, 12);
    expect(r.fmrCi95!.low).toBeLessThan(0.2);
    expect(r.fmrCi95!.high).toBeGreaterThan(0.2);
  });

  it("sweep grid always contains the production threshold and FMR is monotone", () => {
    const grid = deriveSweepGrid([0.6, 0.7], [0.9, 1.0]);
    expect(grid).toContain(PROD);
    const rows = thresholdSweep([0.1, 0.2, 0.5], [0.3, 0.6, 0.9], grid);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.fmr!).toBeGreaterThanOrEqual(rows[i - 1]!.fmr!);
      expect(rows[i]!.fnmr!).toBeLessThanOrEqual(rows[i - 1]!.fnmr!);
    }
  });

  it("finds EER over all thresholds, not only the 500 strictest", () => {
    // Genuine similarity uniform on [0.3, 0.9], impostor on [0.1, 0.5]. Analytic EER = 0.2 at similarity 0.42.
    const genuine = Array.from({ length: 1200 }, (_, i) => 0.3 + (0.6 * (i + 0.5)) / 1200);
    const impostor = Array.from({ length: 2400 }, (_, i) => 0.1 + (0.4 * (i + 0.5)) / 2400);
    const report = computeVerificationReportFromScores({
      datasetName: "eer-fixture",
      modelName: "fixture",
      modelVersion: 1,
      subjectCount: 0,
      imageCount: 0,
      genuineSimilarities: genuine,
      impostorSimilarities: impostor,
    });
    expect(report.eer!).toBeCloseTo(0.2, 2);
    expect(report.eerThresholdSimilarity!).toBeCloseTo(0.42, 2);
    expect(report.roc.length).toBeLessThanOrEqual(500);
    expect(Math.min(...report.roc.map((p) => p.thresholdSimilarity))).toBeLessThan(0.15);
    const roc = summarizeRoc(report);
    expect(roc.eerStatus).toBe("MEASURED");
    expect(roc.eer).toBe(report.eer);
  });

  it("does not report EER as meaningful on tiny samples", () => {
    const report = computeVerificationReportFromScores({
      datasetName: "tiny",
      modelName: "fixture",
      modelVersion: 1,
      subjectCount: 2,
      imageCount: 4,
      genuineSimilarities: [0.9, 0.8, 0.85],
      impostorSimilarities: Array.from({ length: 20 }, (_, i) => i / 40),
    });
    const roc = summarizeRoc(report);
    expect(roc.eerStatus).toBe("NOT_STATISTICALLY_MEANINGFUL");
    expect(roc.eer).toBeNull();
  });
});

describe("assurance lab: threshold recommendation never touches production", () => {
  const coverage = {
    participants: 60,
    participantsWithMinSessions: 60,
    sessions: 120,
    captures: 1200,
    comparableCaptures: 1200,
    genuinePairs: 5000,
    crossSessionGenuinePairs: 2500,
    impostorPairs: 100000,
    platforms: ["WEB", "ANDROID"],
    runtimes: ["CHROME", "ANDROID_WEBVIEW"],
  };
  const gates = { targetFmr: 0.01, minParticipants: 50, minSessionsPerParticipant: 2, minGenuinePairs: 1000, minPlatforms: 2 };
  const spread = (n: number, lo: number, hi: number) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / n);
  const dev = { genuineDistances: spread(2000, 0.05, 0.5), impostorDistances: spread(2000, 0.7, 1.2) };
  const val = { genuineDistances: spread(1000, 0.05, 0.5), impostorDistances: spread(1000, 0.7, 1.2) };
  const grid = deriveSweepGrid([...dev.genuineDistances], [...dev.impostorDistances]);

  it("synthetic evidence is never eligible for calibration", () => {
    const rec = recommendThreshold({ evidenceClass: "SYNTHETIC", gates, coverage, development: dev, validation: val, grid, padStatus: "INCOMPLETE" });
    expect(rec.status).toBe("SYNTHETIC_NOT_ELIGIBLE");
    expect(rec.candidateThresholdDistance).toBeNull();
    expect(rec.appliesToProduction).toBe(false);
  });

  it("returns INSUFFICIENT_EVIDENCE with explicit unmet gates", () => {
    const rec = recommendThreshold({
      evidenceClass: "REAL_HUMAN_CONSENTED",
      gates,
      coverage: { ...coverage, participants: 3, participantsWithMinSessions: 1, crossSessionGenuinePairs: 0, platforms: ["WEB"] },
      development: { genuineDistances: [0.2], impostorDistances: [0.9] },
      validation: { genuineDistances: [], impostorDistances: [] },
      grid,
      padStatus: "INCOMPLETE",
    });
    expect(rec.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(rec.candidateThresholdDistance).toBeNull();
    expect(rec.unmetGates.join(" ")).toMatch(/participants 3 < 50/);
    expect(rec.unmetGates.join(" ")).toMatch(/cross-session/);
    expect(rec.unmetGates.join(" ")).toMatch(/platforms 1 < 2/);
    expect(rec.unmetGates.join(" ")).toMatch(/validation/);
  });

  it("gate logic: produces a governance-only candidate when every gate is met", () => {
    const rec = recommendThreshold({ evidenceClass: "REAL_HUMAN_CONSENTED", gates, coverage, development: dev, validation: val, grid, padStatus: "INCOMPLETE" });
    expect(rec.status).toBe("CANDIDATE_THRESHOLD");
    expect(rec.appliesToProduction).toBe(false);
    expect(rec.requiresGovernanceReview).toBe(true);
    expect(rec.developmentMetrics!.fmrCi95High!).toBeLessThanOrEqual(gates.targetFmr);
    expect(rec.validationMetrics).not.toBeNull();
    expect(rec.productionThresholdDistance).toBe(0.35);
    expect(BIOMETRIC_THRESHOLD_POLICY.threshold).toBe(0.35);
  });
});

describe("assurance lab: 1:N, open-set, ambiguity, duplicate enrollment", () => {
  it("closed-set recall@K and open-set NO_MATCH on a synthetic cohort (infra only)", async () => {
    const f = fixture({ gallery: 12, holdout: 3, seed: 21 });
    const comp = comparableCaptures(f.captures) as ComparableCapture[];
    const holdoutIds = new Set(f.participants.filter((p) => p.cohort === "OPEN_SET_HOLDOUT").map((p) => p.participantId));
    const report = await evaluateIdentification({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp.filter((c) => !holdoutIds.has(c.participantId)),
      holdoutCaptures: comp.filter((c) => holdoutIds.has(c.participantId)),
      retrieverFactory: createExactInMemoryRetriever,
      decide: decider(),
      topK: 10,
      salt: "s",
    });
    expect(report.status).toBe("SYNTHETIC_INFRA_ONLY");
    expect(report.gallerySize).toBe(12);
    expect(report.closedSet.probes).toBe(12 * 4);
    expect(report.closedSet.outcomes.CORRECT_IDENTITY).toBe(12 * 4);
    expect(report.closedSet.recallAtK.K_1).toEqual({ value: 1, applicable: true });
    expect(report.closedSet.recallAtK.K_10!.applicable).toBe(true);
    expect(report.closedSet.recallAtK.K_50!.applicable).toBe(false);
    expect(report.openSet.method).toBe("EXPLICIT_HOLDOUT_PLUS_LEAVE_ONE_PARTICIPANT_OUT");
    expect(report.openSet.probes).toBe(3 * 8 + 12 * 8);
    expect(report.openSet.outcomes.CORRECT_REJECTION).toBe(report.openSet.probes);
    expect(report.openSet.falseIdentificationRate).toBe(0);
  });

  it("gallery keys and retriever inputs never expose participant ids", async () => {
    const f = fixture({ gallery: 5, seed: 22 });
    const comp = comparableCaptures(f.captures) as ComparableCapture[];
    const gallery = buildLabGallery(comp, "salt");
    for (const e of gallery.entries) {
      expect(e.galleryKey).not.toMatch(/lab_p_/);
      expect(Object.keys(e).sort()).toEqual(["embedding", "galleryKey"]);
    }
    const seen: string[] = [];
    await evaluateIdentification({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp,
      holdoutCaptures: [],
      retrieverFactory: (entries) => {
        seen.push(JSON.stringify(entries.map((e) => e.galleryKey)));
        return createExactInMemoryRetriever(entries);
      },
      decide: (probe, candidates) => {
        seen.push(JSON.stringify(candidates.map((c) => c.galleryKey)));
        return decider()(probe, candidates);
      },
      topK: 5,
      salt: "salt",
    });
    expect(seen.join("\n")).not.toMatch(/lab_p_/);
  });

  it("reports AMBIGUOUS when two gallery identities are within the margin", async () => {
    const r = rng(31);
    const shared = randomUnit(r);
    const f = fixture({ gallery: 2, seed: 32, sigma: 0.05 });
    // Force both participants to the same underlying face so templates are near-identical.
    for (const c of f.captures) c.embedding = jitter(shared, 0.05, r);
    const comp = comparableCaptures(f.captures) as ComparableCapture[];
    const report = await evaluateIdentification({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp,
      holdoutCaptures: [],
      retrieverFactory: createExactInMemoryRetriever,
      decide: decider(),
      topK: 5,
      salt: "amb",
      leaveOneOutOpenSet: false,
    });
    expect(report.closedSet.outcomes.AMBIGUOUS).toBe(report.closedSet.probes);
    expect(report.closedSet.mateInTopKButNotFinal).toBe(report.closedSet.probes);
  });

  it("classifies mate-in-Top-K-but-rejected and service failures", async () => {
    const comp = comparableCaptures(fixture({ gallery: 4, seed: 33 }).captures) as ComparableCapture[];
    const strict = await evaluateIdentification({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp,
      holdoutCaptures: [],
      retrieverFactory: createExactInMemoryRetriever,
      decide: decider(0.0001),
      topK: 4,
      salt: "strict",
      leaveOneOutOpenSet: false,
    });
    expect(strict.closedSet.outcomes.MATE_IN_TOPK_REJECTED).toBe(strict.closedSet.probes);
    const broken = await evaluateIdentification({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp,
      holdoutCaptures: [],
      retrieverFactory: () => ({
        mode: "EXACT_IN_MEMORY_TOPK",
        retrieve: async () => {
          throw new Error("down");
        },
      }),
      decide: decider(),
      topK: 4,
      salt: "down",
      leaveOneOutOpenSet: false,
    });
    expect(broken.closedSet.outcomes.SERVICE_UNAVAILABLE).toBe(broken.closedSet.probes);
    expect(broken.closedSet.outcomes.CORRECT_IDENTITY).toBeUndefined();
  });

  it("duplicate enrollment: returning flagged, new CLEAR, outage fails closed, never merges", async () => {
    const comp = comparableCaptures(fixture({ gallery: 6, seed: 34 }).captures) as ComparableCapture[];
    const report = await evaluateDuplicateEnrollment({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp,
      retrieverFactory: createExactInMemoryRetriever,
      assess: assessor,
      topK: 5,
      salt: "dup",
    });
    expect(report.returningAttempts).toBe(6 * 4);
    expect(report.returningFlagged).toBe(report.returningAttempts);
    expect(report.returningFalseClear).toBe(0);
    expect(report.newAttempts).toBe(6);
    expect(report.newClear).toBe(6);
    expect(report.serviceUnavailableFailClosed).toBe(true);
    expect(Object.keys(report.decisions).every((d) => ["CLEAR", "REVIEW_REQUIRED", "AMBIGUOUS", "SERVICE_UNAVAILABLE"].includes(d))).toBe(true);
  });

  it("duplicate enrollment detects an assessor that fails open on outage", async () => {
    const comp = comparableCaptures(fixture({ gallery: 3, seed: 35 }).captures) as ComparableCapture[];
    const failOpen: LabDuplicateAssessor = (probe, retrieval) =>
      retrieval.status === "unavailable" ? { decision: "CLEAR" } : assessor(probe, retrieval);
    const report = await evaluateDuplicateEnrollment({
      evidenceClass: "SYNTHETIC_FIXTURE",
      galleryCaptures: comp,
      retrieverFactory: createExactInMemoryRetriever,
      assess: failOpen,
      topK: 5,
      salt: "dup2",
    });
    expect(report.serviceUnavailableFailClosed).toBe(false);
  });
});

describe("assurance lab: ANN recall governance (synthetic plumbing only)", () => {
  const keyedAssessor: LabDuplicateAssessor = (probe, retrieval) => {
    if (retrieval.status === "unavailable") return { decision: "SERVICE_UNAVAILABLE" };
    const d = decider()(probe, retrieval.candidates);
    const passing = d.ranked.filter((c) => c.distance <= PROD);
    if (!passing.length) return { decision: "CLEAR", candidateGalleryKeys: [] };
    return {
      decision: d.decision === "AMBIGUOUS" ? "AMBIGUOUS" : "REVIEW_REQUIRED",
      candidateGalleryKeys: passing.map((c) => c.galleryKey),
    };
  };

  const cohort = (opts: { gallery: number; holdout: number; seed: number; sigma?: number }) => {
    const f = fixture(opts);
    const comp = comparableCaptures(f.captures) as ComparableCapture[];
    const holdoutIds = new Set(f.participants.filter((p) => p.cohort === "OPEN_SET_HOLDOUT").map((p) => p.participantId));
    return {
      galleryCaptures: comp.filter((c) => !holdoutIds.has(c.participantId)),
      holdoutCaptures: comp.filter((c) => holdoutIds.has(c.participantId)),
    };
  };

  /** Loses the true nearest neighbour: a pure retrieval defect. */
  const dropNearest = (entries: LabGalleryEntry[]): LabRetriever => {
    const exact = createExactInMemoryRetriever(entries);
    return { mode: "PGVECTOR_HNSW_TOPK", retrieve: async (p, k) => (await exact.retrieve(p, k + 1)).slice(1, k + 1) };
  };

  const run = (
    c: ReturnType<typeof cohort>,
    configs: AnnGovernanceConfig[],
    evidenceClass: "REAL_HUMAN" | "SYNTHETIC_FIXTURE" = "SYNTHETIC_FIXTURE",
  ) =>
    evaluateAnnRecallGovernance({
      evidenceClass,
      ...c,
      configs,
      decide: decider(),
      assess: keyedAssessor,
      thresholdDistance: PROD,
      topK: 10,
      salt: "gov",
    });

  it("exact-as-ANN: recall 1.0, no retrieval errors, everything detected, synthetic not claimable", async () => {
    const report = await run(cohort({ gallery: 10, holdout: 3, seed: 51 }), [
      { label: "EXACT_CONTROL", efSearch: null, retrieverFactory: createExactInMemoryRetriever },
    ]);
    const r = report.configs[0]!;
    expect(report.labOnly).toBe(true);
    expect(report.productionChangeApplied).toBe(false);
    expect(report.status).toBe("SYNTHETIC_INFRA_ONLY");
    expect(report.probes).toEqual({ mated: 10 * 4, nonMated: 3 * 8 });
    expect(r.retrieval.recallVsExactAtK.K_1).toBe(1);
    expect(r.retrieval.recallVsExactAtK.K_10).toBe(1);
    expect(r.retrieval.recallVsExactAtK.K_50).toBeNull();
    expect(r.retrieval.mateRecallAtK.K_1).toBe(1);
    expect(r.retrieval.candidateMissRate).toBe(0);
    expect(r.identification.mated.errorAttribution).toEqual({ CORRECT: 40 });
    expect(r.duplicateGate.returning).toMatchObject({ attempts: 40, detected: 40, annRetrievalMiss: 0, thresholdRejection: 0 });
    expect(r.duplicateGate.returning.detectionRate).toBe(1);
    expect(r.duplicateGate.newParticipants).toMatchObject({ attempts: 24, clear: 24 });
    expect(r.falseClear).toMatchObject({ observed: 0, trials: 40, claimable: false });
    expect(r.falseClear.statement).toMatch(/^SYNTHETIC/);
    expect(report.falseClearHeadline).toEqual([
      { label: "EXACT_CONTROL", observed: 0, trials: 40, upper95: r.falseClear.ci95!.high, claimable: false },
    ]);
  });

  it("separates RETRIEVAL error from MATCHING/THRESHOLD error", async () => {
    const c = cohort({ gallery: 10, holdout: 2, seed: 52 });
    const report = await run(c, [
      { label: "EXACT_CONTROL", efSearch: null, retrieverFactory: createExactInMemoryRetriever },
      { label: "LOSES_NEAREST", efSearch: 1, retrieverFactory: dropNearest },
    ]);
    const lossy = report.configs[1]!;
    expect(lossy.retrieval.recallVsExactAtK.K_1).toBe(0);
    expect(lossy.retrieval.mateRecallAtK.K_1).toBe(0);
    expect(lossy.retrieval.candidateMissRate).toBeGreaterThan(0);
    expect(lossy.identification.mated.errorAttribution.RETRIEVAL_ERROR).toBe(40);
    expect(lossy.identification.mated.errorAttribution.MATCHING_THRESHOLD_ERROR).toBeUndefined();
    expect(lossy.duplicateGate.returning.annRetrievalMiss).toBe(40);
    expect(lossy.duplicateGate.returning.thresholdRejection).toBe(0);
    expect(lossy.falseClear).toMatchObject({ observed: 40, byCause: { annRetrievalMiss: 40, thresholdRejection: 0 } });

    const noisy = await run(cohort({ gallery: 10, holdout: 2, seed: 53, sigma: 1.4 }), [
      { label: "EXACT_CONTROL", efSearch: null, retrieverFactory: createExactInMemoryRetriever },
    ]);
    const n = noisy.configs[0]!;
    expect(n.duplicateGate.returning.thresholdRejection).toBeGreaterThan(0);
    expect(n.duplicateGate.returning.annRetrievalMiss).toBe(0);
    expect(n.identification.mated.errorAttribution.MATCHING_THRESHOLD_ERROR).toBeGreaterThan(0);
    expect(n.identification.mated.errorAttribution.RETRIEVAL_ERROR).toBeUndefined();
    expect(n.falseClear.byCause.thresholdRejection).toBe(n.falseClear.observed);
  });

  it("short candidate lists are measured, and an outage is never CLEAR", async () => {
    const c = cohort({ gallery: 8, holdout: 2, seed: 54 });
    const truncating = (entries: LabGalleryEntry[]): LabRetriever => {
      const exact = createExactInMemoryRetriever(entries);
      return { mode: "PGVECTOR_HNSW_TOPK", retrieve: async (p) => exact.retrieve(p, 2) };
    };
    const failing = (): LabRetriever => ({
      mode: "PGVECTOR_HNSW_TOPK",
      retrieve: async () => {
        throw new Error("index down");
      },
    });
    const report = await run(c, [
      { label: "TRUNCATED_TO_2", efSearch: 2, retrieverFactory: truncating },
      { label: "OUTAGE", efSearch: 64, retrieverFactory: failing },
    ]);
    const [t, o] = report.configs;
    expect(t!.retrieval.shortResultProbes).toBe(t!.retrieval.probes);
    expect(t!.retrieval.meanCandidatesReturned).toBe(2);
    expect(t!.retrieval.recallVsExactAtK.K_5).toBeCloseTo(0.4, 5);
    expect(t!.retrieval.recallVsExactAtK.K_10).toBeNull();
    expect(o!.retrieval.unavailable).toBe(o!.retrieval.probes);
    expect(o!.duplicateGate.returning.serviceUnavailable).toBe(o!.duplicateGate.returning.attempts);
    expect(o!.duplicateGate.returning.blockedRate).toBe(1);
    expect(o!.duplicateGate.newParticipants.clear).toBe(0);
    expect(o!.falseClear.observed).toBe(0);
    expect(o!.identification.mated.outcomes).toEqual({ SERVICE_UNAVAILABLE: 32 });
    expect(o!.latencyMs.count).toBe(0);
  });

  it("timeouts under concurrent load are counted as failures and do not abort the run", async () => {
    let calls = 0;
    const flaky = (entries: LabGalleryEntry[]): LabRetriever => {
      const exact = createExactInMemoryRetriever(entries);
      return {
        mode: "PGVECTOR_HNSW_TOPK",
        retrieve: async (p, k) => {
          if (++calls % 3 === 0) throw new Error("canceling statement due to statement timeout");
          return exact.retrieve(p, k);
        },
      };
    };
    const report = await evaluateAnnRecallGovernance({
      evidenceClass: "SYNTHETIC_FIXTURE",
      ...cohort({ gallery: 6, holdout: 1, seed: 57 }),
      configs: [{ label: "FLAKY", efSearch: 512, retrieverFactory: flaky }],
      decide: decider(),
      assess: keyedAssessor,
      thresholdDistance: PROD,
      topK: 5,
      salt: "flaky",
      concurrency: [4],
    });
    const r = report.configs[0]!;
    const probes = report.probes.mated + report.probes.nonMated;
    expect(r.retrieval.unavailable).toBeGreaterThan(0);
    expect(r.latencyMs.count).toBe(probes - r.retrieval.unavailable);
    expect(r.duplicateGate.returning.serviceUnavailable + r.duplicateGate.newParticipants.serviceUnavailable).toBe(r.retrieval.unavailable);
    const q = r.qps.concurrent[0]!;
    expect(q.failed).toBeGreaterThan(0);
    expect(q.queries + q.failed).toBe(probes);
  });

  it("latency, sequential and concurrent QPS are reported; report carries no embeddings", async () => {
    const report = await evaluateAnnRecallGovernance({
      evidenceClass: "SYNTHETIC_FIXTURE",
      ...cohort({ gallery: 6, holdout: 1, seed: 55 }),
      configs: [{ label: "EXACT_CONTROL", efSearch: null, retrieverFactory: createExactInMemoryRetriever }],
      decide: decider(),
      assess: keyedAssessor,
      thresholdDistance: PROD,
      topK: 5,
      salt: "lat",
      concurrency: [1, 4],
    });
    const r = report.configs[0]!;
    expect(r.latencyMs.count).toBe(report.probes.mated + report.probes.nonMated);
    expect(r.latencyMs.p99).not.toBeNull();
    expect(r.qps.sequential).toBeGreaterThan(0);
    expect(r.qps.concurrent.map((q) => q.clients)).toEqual([1, 4]);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/"(embedding|vector)"\s*:/);
    expect(json).not.toMatch(/lab_p_/);
  });

  it("false CLEAR on real evidence: zero observed is reported with its bound, never as zero rate", () => {
    const zero = falseClearMetric({ observed: 0, trials: 300, annRetrievalMiss: 0, thresholdRejection: 0, evidenceClass: "REAL_HUMAN" });
    expect(zero.claimable).toBe(true);
    expect(zero.rate).toBe(0);
    expect(zero.ci95!.high).toBeGreaterThan(0.005);
    expect(zero.statement).toMatch(/Zero observed is not a zero rate/);
    const none = falseClearMetric({ observed: 0, trials: 0, annRetrievalMiss: 0, thresholdRejection: 0, evidenceClass: "REAL_HUMAN" });
    expect(none).toMatchObject({ claimable: false, rate: null, ci95: null });
    expect(none.statement).toMatch(/UNMEASURED/);
    const synthetic = falseClearMetric({ observed: 0, trials: 500, annRetrievalMiss: 0, thresholdRejection: 0, evidenceClass: "SYNTHETIC_FIXTURE" });
    expect(synthetic.claimable).toBe(false);
  });

  it("real-evidence status requires returning participants", async () => {
    const empty = await run({ galleryCaptures: [], holdoutCaptures: [] }, [
      { label: "EXACT_CONTROL", efSearch: null, retrieverFactory: createExactInMemoryRetriever },
    ], "REAL_HUMAN");
    expect(empty.status).toBe("INSUFFICIENT_DATA");
    expect(empty.configs[0]!.falseClear.statement).toMatch(/UNMEASURED/);
  });
});

describe("assurance lab: PAD", () => {
  const attempt = (presentation: LabPadAttempt["presentation"], padDecision: LabPadAttempt["padDecision"], i: number): LabPadAttempt => ({
    schemaVersion: "trustid_assurance_lab_pad_attempt_v1",
    resultKind: "EVALUATION_RESULT",
    attemptId: `a${i}`,
    studyId: "lab_test_study",
    participantId: "lab_p_0000",
    sessionId: "s",
    presentation,
    expected: expectedPadDecision(presentation),
    padDecision,
    padMethod: "active_blink",
    challengeResult: "PASSED",
    qualityDecision: "PASS",
    environment: WEB_CHROME,
    recordedAt: "2026-09-02T00:00:00.000Z",
    rawMediaRetained: false,
  });

  it("computes BPCER/APCER per class and never counts UNAVAILABLE as defended", () => {
    const attempts = [
      attempt("BONA_FIDE_LIVE", "PASS", 1),
      attempt("BONA_FIDE_LIVE", "PASS", 2),
      attempt("BONA_FIDE_LIVE", "REJECT", 3),
      attempt("STATIC_PHOTO", "REJECT", 4),
      attempt("STATIC_PHOTO", "PASS", 5),
      attempt("SCREEN_DISPLAY", "UNAVAILABLE", 6),
      attempt("PRERECORDED_VIDEO", "NOT_RUN", 7),
    ];
    const r = computePadReport(attempts);
    expect(r.bonaFide.bpcer).toBeCloseTo(1 / 3, 12);
    expect(r.attackClasses.STATIC_PHOTO!.apcer).toBe(0.5);
    expect(r.attackClasses.SCREEN_DISPLAY!.decided).toBe(0);
    expect(r.attackClasses.SCREEN_DISPLAY!.apcer).toBeNull();
    expect(r.undecidedAttempts).toBe(2);
    expect(r.status).toBe("INSUFFICIENT_DATA");
    expect(r.productionReady).toBe(false);
    expect(expectedPadDecision("BONA_FIDE_LIVE")).toBe("PASS");
    expect(expectedPadDecision("SCREEN_DISPLAY")).toBe("REJECT");
  });

  it("is EVALUATED with enough attempts but still never production-ready", () => {
    const attempts: LabPadAttempt[] = [];
    let i = 0;
    for (const p of ["BONA_FIDE_LIVE", "STATIC_PHOTO", "SCREEN_DISPLAY", "PRERECORDED_VIDEO"] as const) {
      for (let k = 0; k < 100; k++) attempts.push(attempt(p, expectedPadDecision(p), i++));
    }
    const r = computePadReport(attempts);
    expect(r.status).toBe("EVALUATED");
    expect(r.maxApcer).toBe(0);
    expect(r.productionReady).toBe(false);
    expect(computePadReport([]).status).toBe("NO_DATA");
  });
});

describe("assurance lab: full analysis, isolation, export, withdrawal", () => {
  it("synthetic study is infra-only: calibration READY_FOR_DATA, statuses BLOCKED, production untouched", async () => {
    const f = fixture({ gallery: 8, holdout: 2, seed: 41 });
    const before = JSON.stringify(BIOMETRIC_THRESHOLD_POLICY);
    const report = await analyze(f);
    expect(report.resultKind).toBe("EVALUATION_RESULT");
    expect(report.evidence.evidenceClass).toBe("SYNTHETIC");
    expect(report.recommendation.status).toBe("SYNTHETIC_NOT_ELIGIBLE");
    expect(report.statuses).toMatchObject({ calibration: "READY_FOR_DATA", oneToOne: "BLOCKED", oneToN: "BLOCKED" });
    expect(report.production.thresholdDistance).toBe(0.35);
    expect(report.recognition.atProductionThreshold!.thresholdDistance).toBe(0.35);
    expect(report.evidence.impostorSampling.method).toBe("EXHAUSTIVE");
    expect(report.evidence.platforms.WEB!.captures).toBeGreaterThan(0);
    expect(report.evidence.platforms.ANDROID!.captures).toBeGreaterThan(0);
    expect(report.evidence.platforms.IOS!.captures).toBe(0);
    expect(report.recognition.strata.CROSS_SESSION!.pairs).toBeGreaterThan(0);
    expect(report.evidence.contractCompatibility.valid).toBe(report.evidence.contractCompatibility.trialsChecked);
    expect(report.evidence.contractCompatibility.accuracyClaimEligible).toBe(0);
    expect(JSON.stringify(BIOMETRIC_THRESHOLD_POLICY)).toBe(before);
  });

  it("real-human evidence below the gates reports INSUFFICIENT_DATA, not a threshold", async () => {
    const report = await analyze(fixture({ gallery: 4, provenance: "REAL_HUMAN_CONSENTED", seed: 42 }));
    expect(report.recommendation.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.recommendation.candidateThresholdDistance).toBeNull();
    expect(report.statuses.calibration).toBe("INSUFFICIENT_DATA");
  });

  it("lab output carries no identity or authority fields", async () => {
    const report = await analyze(fixture({ gallery: 4, seed: 43 }));
    expect(Object.values(report.authorityBoundary).every((v) => v === false)).toBe(true);
    expect(LAB_AUTHORITY_BOUNDARY.changesProductionThreshold).toBe(false);
    expect(() => assertLabResponseIsolation(report)).not.toThrow();
    expect(() => assertLabResponseIsolation({ a: { sessionToken: "x" } })).toThrow(/sessionToken/);
    expect(() => assertLabResponseIsolation({ trustId: "tid_1" })).toThrow(/trustId/);
  });

  it("export is deterministic, aggregate-only, and free of ids, vectors, and secrets", async () => {
    const f = fixture({ gallery: 6, holdout: 1, seed: 44 });
    const a = buildAssuranceExport(await analyze(f));
    const b = buildAssuranceExport(await analyze(f));
    expect(a.json).toBe(b.json);
    expect(a.json).not.toMatch(/lab_p_/);
    expect(a.json).not.toMatch(/"generatedAt":/);
    expect(a.json).not.toMatch(/"latencyMs":/);
    expect(a.json).not.toMatch(/"embedding"/);
    expect(() => assertExportPrivacy({ x: { embedding: [1] } })).toThrow();
    expect(() => assertExportPrivacy({ trustId: "t" })).toThrow();
    expect(() => assertExportPrivacy({ participantId: "lab_p_1" })).toThrow();
    expect(() => assertExportPrivacy({ v: Array.from({ length: 512 }, () => 0.01) })).toThrow(/vector/);
    expect(() => assertExportPrivacy({ img: "data:image/png;base64,AAAA" })).toThrow();
    expect(() => assertExportPrivacy({ k: "-----BEGIN PRIVATE KEY-----\nabc" })).toThrow();
  });

  it("withdrawn participants are excluded from every analysis", async () => {
    const f = fixture({ gallery: 5, seed: 45 });
    const full = await analyze(f);
    f.participants[0]!.status = "WITHDRAWN";
    const after = await analyze(f);
    expect(after.evidence.participants).toBe(full.evidence.participants - 1);
    expect(after.evidence.captures).toBe(full.evidence.captures - 8);
    expect(after.identification.gallerySize).toBe(4);
  });
});
