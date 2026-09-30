import {
  BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
  BIOMETRIC_PAD_STATUS,
  BIOMETRIC_THRESHOLD_POLICY,
} from "@trustid/shared";
import { computeVerificationReportFromScores } from "../benchmark/metrics.js";
import { validateBiometricEvaluationTrial } from "../evaluation/contract.js";
import { assignSubjectDisjointSplits } from "../evaluation/validate.js";
import {
  deriveSweepGrid,
  recommendThreshold,
  summarizeRoc,
  thresholdSweep,
  type EvidenceCoverage,
  type ThresholdRecommendation,
  type ThresholdSweepRow,
} from "./calibration.js";
import { assertSingleEvidenceClass, LAB_PRODUCTION_MODEL, pairToEvaluationTrial } from "./evidence.js";
import {
  evaluateDuplicateEnrollment,
  evaluateIdentification,
  type LabDuplicateAssessor,
  type LabDuplicateEnrollmentReport,
  type LabIdentificationDecider,
  type LabIdentificationReport,
  type LabRetrieverFactory,
} from "./identification.js";
import { LAB_AUTHORITY_BOUNDARY } from "./isolation.js";
import { computePadReport, type LabPadAttempt, type LabPadReport } from "./pad.js";
import {
  comparableCaptures,
  forEachImpostorPair,
  generateGenuinePairs,
  type ComparableCapture,
  type ImpostorSamplingSummary,
} from "./pairs.js";
import type { LabStudyConfig } from "./protocol.js";
import type {
  LabCaptureRecord,
  LabEvidenceProvenance,
  LabPairRecord,
  LabParticipant,
  LabSession,
} from "./types.js";

export type DistributionStats = {
  count: number;
  mean: number | null;
  std: number | null;
  min: number | null;
  p05: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

function stats(values: number[]): DistributionStats {
  if (!values.length) {
    return { count: 0, mean: null, std: null, min: null, p05: null, p50: null, p95: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  const std =
    sorted.length > 1
      ? Math.sqrt(sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (sorted.length - 1))
      : 0;
  return {
    count: sorted.length,
    mean,
    std,
    min: sorted[0]!,
    p05: q(0.05),
    p50: q(0.5),
    p95: q(0.95),
    max: sorted[sorted.length - 1]!,
  };
}

function histogram(genuine: number[], impostor: number[], binWidth = 0.02) {
  const all = [...genuine, ...impostor];
  if (!all.length) return { binWidth, bins: [] as Array<{ lo: number; hi: number; genuine: number; impostor: number }> };
  let min = Infinity;
  let max = -Infinity;
  for (const x of all) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const start = Math.floor(min / binWidth);
  const end = Math.floor(max / binWidth);
  const bins = Array.from({ length: end - start + 1 }, (_, i) => ({
    lo: Number(((start + i) * binWidth).toFixed(4)),
    hi: Number(((start + i + 1) * binWidth).toFixed(4)),
    genuine: 0,
    impostor: 0,
  }));
  for (const d of genuine) bins[Math.floor(d / binWidth) - start]!.genuine++;
  for (const d of impostor) bins[Math.floor(d / binWidth) - start]!.impostor++;
  return { binWidth, bins };
}

export type LabStudyReport = {
  schema: "trustid_assurance_lab_report_v1";
  generatedAt: string;
  resultKind: "EVALUATION_RESULT";
  authorityBoundary: typeof LAB_AUTHORITY_BOUNDARY;
  study: {
    studyId: string;
    studyVersion: string;
    consentVersion: string;
    title: string;
    evidenceRetentionDays: number;
    rawImagePolicy: string;
    sampleSizeRationale: string;
    protocol: Array<{
      key: string;
      title: string;
      steps: Array<{ key: string; targetCaptures: number; allowedConditions: string[] }>;
    }>;
  };
  production: {
    source: "@trustid/shared (read-only)";
    thresholdDistance: number;
    thresholdStatus: string;
    ambiguityMarginDistance: number;
    padStatus: string;
    model: typeof LAB_PRODUCTION_MODEL;
  };
  evidence: {
    evidenceClass: LabEvidenceProvenance | "NONE";
    participants: number;
    gallery: number;
    openSetHoldout: number;
    sessions: number;
    captures: number;
    comparableCaptures: number;
    failureToAcquire: { count: number; rate: number | null };
    genuinePairs: number;
    impostorPairs: number;
    impostorSampling: ImpostorSamplingSummary;
    platforms: Record<string, { sessions: number; captures: number }>;
    runtimes: Record<string, number>;
    conditions: Record<string, number>;
    captureLatencyMs: { embeddingStage: DistributionStats; total: DistributionStats };
    contractCompatibility: { trialsChecked: number; valid: number; accuracyClaimEligible: number };
  };
  recognition: {
    genuineDistance: DistributionStats;
    impostorDistance: DistributionStats;
    histogram: ReturnType<typeof histogram>;
    strata: Record<string, { pairs: number; meanDistance: number | null; fnmrAtProduction: number | null }>;
    sweep: ThresholdSweepRow[];
    atProductionThreshold: ThresholdSweepRow | null;
    roc: ReturnType<typeof summarizeRoc>;
  };
  recommendation: ThresholdRecommendation;
  identification: LabIdentificationReport;
  duplicateEnrollment: LabDuplicateEnrollmentReport;
  pad: LabPadReport;
  statuses: {
    calibration: "READY_FOR_DATA" | "INSUFFICIENT_DATA" | "CANDIDATE_PENDING_GOVERNANCE_REVIEW";
    oneToOne: "BLOCKED" | "MEASURED_PENDING_REVIEW";
    oneToN: "BLOCKED" | "MEASURED_PENDING_REVIEW";
    pad: LabPadReport["status"];
  };
  limitations: string[];
};

export type AnalyzeLabStudyInput = {
  study: LabStudyConfig;
  participants: LabParticipant[];
  sessions: LabSession[];
  captures: LabCaptureRecord[];
  padAttempts: LabPadAttempt[];
  retrieverFactory: LabRetrieverFactory;
  decide: LabIdentificationDecider;
  assessDuplicate: LabDuplicateAssessor;
  topK: number;
  now?: () => Date;
};

/** Full lab analysis. Reads production policy; never writes it. */
export async function analyzeLabStudy(input: AnalyzeLabStudyInput): Promise<LabStudyReport> {
  const active = new Set(input.participants.filter((p) => p.status === "ACTIVE").map((p) => p.participantId));
  const cohort = new Map(input.participants.map((p) => [p.participantId, p.cohort]));
  const captures = input.captures.filter((c) => active.has(c.participantId));
  const sessions = input.sessions.filter((s) => active.has(s.participantId));
  const evidenceClass = assertSingleEvidenceClass(captures);
  const comparable = comparableCaptures(captures);
  const galleryCaptures = comparable.filter((c) => cohort.get(c.participantId) !== "OPEN_SET_HOLDOUT");
  const holdoutCaptures = comparable.filter((c) => cohort.get(c.participantId) === "OPEN_SET_HOLDOUT");
  const production = BIOMETRIC_THRESHOLD_POLICY.threshold;

  // Recognition (1:1 pairs) uses every comparable capture, holdouts included.
  const genuinePairs = generateGenuinePairs(comparable);
  const splitIds = [...new Set(comparable.map((c) => c.participantId))];
  const split = assignSubjectDisjointSplits(splitIds, { development: 0.6, validation: 0.4, test: 0 }, 7);
  const isDev = (id: string) => split.get(id) === "development";

  const genuineSim = genuinePairs.map((p) => p.similarity);
  const genuineDist = genuinePairs.map((p) => p.distance);
  const impostorSim: number[] = [];
  const impostorDist: number[] = [];
  const dev = { genuineDistances: [] as number[], impostorDistances: [] as number[] };
  const val = { genuineDistances: [] as number[], impostorDistances: [] as number[] };
  for (const p of genuinePairs) (isDev(p.participantA) ? dev : val).genuineDistances.push(p.distance);

  const byCapture = new Map(comparable.map((c) => [c.captureId, c]));
  const contract = { trialsChecked: 0, valid: 0, accuracyClaimEligible: 0 };
  const checkContract = (pair: LabPairRecord) => {
    if (contract.trialsChecked >= 20_000) return;
    const trial = pairToEvaluationTrial({
      runId: `${input.study.studyId}:analysis`,
      pair,
      enrollment: byCapture.get(pair.captureA)!,
      probe: byCapture.get(pair.captureB)!,
      thresholdDistance: production,
      accepted: pair.distance <= production,
    });
    const v = validateBiometricEvaluationTrial(trial);
    contract.trialsChecked++;
    if (v.valid) contract.valid++;
    if (v.biometricAccuracyClaimAllowed) contract.accuracyClaimEligible++;
  };
  genuinePairs.forEach(checkContract);

  const sampling = forEachImpostorPair(comparable, input.study.impostorSampling, (pair) => {
    impostorSim.push(pair.similarity);
    impostorDist.push(pair.distance);
    const aDev = isDev(pair.participantA);
    if (aDev === isDev(pair.participantB)) (aDev ? dev : val).impostorDistances.push(pair.distance);
    checkContract(pair);
  });

  const grid = deriveSweepGrid(genuineDist, impostorDist);
  const sweep = thresholdSweep(genuineDist, impostorDist, grid);
  const verification = computeVerificationReportFromScores({
    datasetName: input.study.studyId,
    modelName: LAB_PRODUCTION_MODEL.name,
    modelVersion: LAB_PRODUCTION_MODEL.version,
    subjectCount: splitIds.length,
    imageCount: comparable.length,
    genuineSimilarities: genuineSim,
    impostorSimilarities: impostorSim,
    syntheticPlumbingOnly: evidenceClass === "SYNTHETIC",
    operatingThresholdDistance: production,
  });

  const stratum = (pairs: LabPairRecord[]) => ({
    pairs: pairs.length,
    meanDistance: pairs.length ? pairs.reduce((s, p) => s + p.distance, 0) / pairs.length : null,
    fnmrAtProduction: pairs.length ? pairs.filter((p) => p.distance > production).length / pairs.length : null,
  });
  const strata: LabStudyReport["recognition"]["strata"] = {
    SAME_SESSION: stratum(genuinePairs.filter((p) => p.sameSession)),
    CROSS_SESSION: stratum(genuinePairs.filter((p) => !p.sameSession)),
    CROSS_RUNTIME_OR_DEVICE: stratum(genuinePairs.filter((p) => p.crossRuntimeOrDevice)),
  };
  for (const cond of [...new Set(genuinePairs.flatMap((p) => p.probeConditions))].sort()) {
    strata[`PROBE_${cond}`] = stratum(genuinePairs.filter((p) => p.probeConditions.includes(cond)));
  }

  const sessionsPerParticipant = new Map<string, Set<string>>();
  for (const c of comparable) {
    const set = sessionsPerParticipant.get(c.participantId) ?? new Set<string>();
    set.add(c.sessionId);
    sessionsPerParticipant.set(c.participantId, set);
  }
  const platformCounts: LabStudyReport["evidence"]["platforms"] = {
    WEB: { sessions: 0, captures: 0 },
    ANDROID: { sessions: 0, captures: 0 },
    IOS: { sessions: 0, captures: 0 },
  };
  for (const s of sessions) platformCounts[s.environment.platform]!.sessions++;
  for (const c of captures) platformCounts[c.environment.platform]!.captures++;
  const count = (keys: string[]) => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = (out[k] ?? 0) + 1;
    return out;
  };

  const coverage: EvidenceCoverage = {
    participants: active.size,
    participantsWithMinSessions: [...sessionsPerParticipant.values()].filter(
      (s) => s.size >= input.study.calibration.minSessionsPerParticipant,
    ).length,
    sessions: sessions.length,
    captures: captures.length,
    comparableCaptures: comparable.length,
    genuinePairs: genuinePairs.length,
    crossSessionGenuinePairs: strata.CROSS_SESSION!.pairs,
    impostorPairs: impostorSim.length,
    platforms: Object.entries(platformCounts)
      .filter(([, v]) => v.captures > 0)
      .map(([k]) => k),
    runtimes: [...new Set(captures.map((c) => c.environment.runtime))].sort(),
  };

  const recommendation = recommendThreshold({
    evidenceClass,
    gates: input.study.calibration,
    coverage,
    development: dev,
    validation: val,
    grid,
    padStatus: BIOMETRIC_PAD_STATUS.INCOMPLETE,
  });

  const contractClass = evidenceClass === "REAL_HUMAN_CONSENTED" ? "REAL_HUMAN" : "SYNTHETIC_FIXTURE";
  const identification = await evaluateIdentification({
    evidenceClass: contractClass,
    galleryCaptures: galleryCaptures as ComparableCapture[],
    holdoutCaptures: holdoutCaptures as ComparableCapture[],
    retrieverFactory: input.retrieverFactory,
    decide: input.decide,
    topK: input.topK,
    salt: input.study.studyId,
  });
  const duplicateEnrollment = await evaluateDuplicateEnrollment({
    evidenceClass: contractClass,
    galleryCaptures: galleryCaptures as ComparableCapture[],
    retrieverFactory: input.retrieverFactory,
    assess: input.assessDuplicate,
    topK: input.topK,
    salt: input.study.studyId,
  });
  const pad = computePadReport(input.padAttempts.filter((a) => active.has(a.participantId)));

  const realData = evidenceClass === "REAL_HUMAN_CONSENTED" && comparable.length > 0;
  const fta = captures.filter((c) => c.quality.decision !== "PASS").length;

  return {
    schema: "trustid_assurance_lab_report_v1",
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    resultKind: "EVALUATION_RESULT",
    authorityBoundary: LAB_AUTHORITY_BOUNDARY,
    study: {
      studyId: input.study.studyId,
      studyVersion: input.study.studyVersion,
      consentVersion: input.study.consentVersion,
      title: input.study.title,
      evidenceRetentionDays: input.study.evidenceRetentionDays,
      rawImagePolicy: input.study.rawImagePolicy,
      sampleSizeRationale: input.study.sampleSizeRationale,
      protocol: input.study.sessions.map((s) => ({
        key: s.key,
        title: s.title,
        steps: s.steps.map((st) => ({
          key: st.key,
          targetCaptures: st.targetCaptures,
          allowedConditions: [...st.allowedConditions],
        })),
      })),
    },
    production: {
      source: "@trustid/shared (read-only)",
      thresholdDistance: production,
      thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
      ambiguityMarginDistance: BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
      padStatus: BIOMETRIC_PAD_STATUS.INCOMPLETE,
      model: LAB_PRODUCTION_MODEL,
    },
    evidence: {
      evidenceClass: evidenceClass ?? "NONE",
      participants: active.size,
      gallery: new Set(galleryCaptures.map((c) => c.participantId)).size,
      openSetHoldout: new Set(holdoutCaptures.map((c) => c.participantId)).size,
      sessions: sessions.length,
      captures: captures.length,
      comparableCaptures: comparable.length,
      failureToAcquire: { count: fta, rate: captures.length ? fta / captures.length : null },
      genuinePairs: genuinePairs.length,
      impostorPairs: impostorSim.length,
      impostorSampling: sampling,
      platforms: platformCounts,
      runtimes: count(captures.map((c) => c.environment.runtime)),
      conditions: count(captures.flatMap((c) => c.conditions)),
      captureLatencyMs: {
        embeddingStage: stats(
          captures.map((c) => c.latencyMs.embedding).filter((x): x is number => Number.isFinite(x)),
        ),
        total: stats(captures.map((c) => c.latencyMs.total).filter(Number.isFinite)),
      },
      contractCompatibility: contract,
    },
    recognition: {
      genuineDistance: stats(genuineDist),
      impostorDistance: stats(impostorDist),
      histogram: histogram(genuineDist, impostorDist),
      strata,
      sweep,
      atProductionThreshold: sweep.find((r) => r.isProductionThreshold) ?? null,
      roc: summarizeRoc(verification),
    },
    recommendation,
    identification,
    duplicateEnrollment,
    pad,
    statuses: {
      calibration: !realData
        ? "READY_FOR_DATA"
        : recommendation.status === "CANDIDATE_THRESHOLD"
          ? "CANDIDATE_PENDING_GOVERNANCE_REVIEW"
          : "INSUFFICIENT_DATA",
      oneToOne: realData && verification.status === "MEASURED" ? "MEASURED_PENDING_REVIEW" : "BLOCKED",
      oneToN: realData && identification.status === "MEASURED" ? "MEASURED_PENDING_REVIEW" : "BLOCKED",
      pad: pad.status,
    },
    limitations: [
      "Lab results are EVALUATION_RESULT only; they never authenticate, create a TrustID, or grant authority.",
      `Production threshold ${production} (${BIOMETRIC_THRESHOLD_POLICY.status}) is read, never written, by the lab.`,
      "Capture conditions are operator labels, not measured properties.",
      "Embeddings are client-produced; capture provenance is not hardware-attested.",
      "Convenience sample: demographic balance is not measured or claimed.",
      identification.retrievalMode === "EXACT_IN_MEMORY_TOPK"
        ? "1:N retrieval used exact in-memory Top-K over the lab gallery (not HNSW); decisions use the production rerank/threshold/ambiguity code."
        : "1:N retrieval used a disposable pgvector HNSW index.",
    ],
  };
}
