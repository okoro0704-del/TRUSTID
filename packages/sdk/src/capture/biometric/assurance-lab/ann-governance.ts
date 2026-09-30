/**
 * ANN recall governance (LAB ONLY).
 *
 * Measures how the production retrieval policy (HNSW Top-K at a given
 * ef_search) behaves against an exact cosine reference on the same gallery,
 * and attributes every failure to either RETRIEVAL (the ANN candidate set lost
 * something the exact search had) or MATCHING/THRESHOLD (the exact search
 * itself would have decided wrongly). Decisions are the production ones,
 * injected by the caller. Nothing here can change production configuration;
 * results are EVALUATION_RESULTs that feed a human governance decision.
 */
import { wilsonInterval95 } from "../benchmark/stats.js";
import {
  buildLabGallery,
  createExactInMemoryRetriever,
  retrieveOutcome,
  type LabDuplicateAssessor,
  type LabGalleryEntry,
  type LabIdentificationDecider,
  type LabRetrievalOutcome,
  type LabRetrievedCandidate,
  type LabRetriever,
} from "./identification.js";
import type { ComparableCapture } from "./pairs.js";

export const ANN_GOVERNANCE_SCHEMA_VERSION = "trustid_ann_recall_governance_v1";

export type AnnGovernanceEvidenceClass = "REAL_HUMAN" | "SYNTHETIC_FIXTURE";

/** One retrieval configuration to measure (e.g. production as implemented, or a lab ef_search). */
export type AnnGovernanceConfig = {
  label: string;
  /** null = whatever the database applies when the production call sequence runs. */
  efSearch: number | null;
  note?: string;
  retrieverFactory: (entries: LabGalleryEntry[]) => Promise<LabRetriever> | LabRetriever;
};

export type LatencySummary = { count: number; p50: number | null; p95: number | null; p99: number | null; mean: number | null };

export type FalseClearMetric = {
  /** Returning participants (already enrolled) for whom the duplicate gate said CLEAR. */
  observed: number;
  trials: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  byCause: { annRetrievalMiss: number; thresholdRejection: number };
  evidenceClass: AnnGovernanceEvidenceClass;
  /** Only real consented human evidence can support any false-CLEAR claim. */
  claimable: boolean;
  statement: string;
};

export type AnnConfigResult = {
  label: string;
  efSearch: number | null;
  note?: string;
  retrievalMode: LabRetriever["mode"];
  retrieval: {
    probes: number;
    recallVsExactAtK: Record<string, number | null>;
    mateRecallAtK: Record<string, number | null>;
    /** Exact candidates within threshold that the ANN set did not return. */
    passingCandidatesExact: number;
    passingCandidatesMissed: number;
    candidateMissRate: number | null;
    /** Probes where ANN returned fewer than min(topK, gallery) candidates. */
    shortResultProbes: number;
    meanCandidatesReturned: number | null;
    unavailable: number;
  };
  identification: {
    mated: {
      probes: number;
      outcomes: Record<string, number>;
      matchRate: number | null;
      ambiguousRate: number | null;
      noMatchRate: number | null;
      errorAttribution: Record<string, number>;
    };
    nonMated: {
      probes: number;
      outcomes: Record<string, number>;
      falseIdentificationRate: number | null;
      ambiguousRate: number | null;
      noMatchRate: number | null;
      errorAttribution: Record<string, number>;
    };
  };
  duplicateGate: {
    returning: {
      attempts: number;
      detected: number;
      ambiguity: number;
      blockedByOtherIdentity: number;
      annRetrievalMiss: number;
      thresholdRejection: number;
      serviceUnavailable: number;
      /** REVIEW_REQUIRED naming the returning participant. */
      detectionRate: number | null;
      /** Any outcome other than CLEAR (no identity created); equals 1 - false-CLEAR rate. */
      blockedRate: number | null;
    };
    newParticipants: {
      attempts: number;
      clear: number;
      falseDuplicateReview: number;
      ambiguous: number;
      serviceUnavailable: number;
    };
  };
  falseClear: FalseClearMetric;
  latencyMs: LatencySummary;
  qps: { sequential: number | null; concurrent: ConcurrentRun[] };
};

/** Failed queries (timeouts, outages) are counted, never timed, and never abort the run. */
export type ConcurrentRun = { clients: number; queries: number; failed: number; qps: number; latencyMs: LatencySummary };

export type AnnGovernanceReport = {
  schemaVersion: typeof ANN_GOVERNANCE_SCHEMA_VERSION;
  resultKind: "EVALUATION_RESULT";
  labOnly: true;
  productionChangeApplied: false;
  evidenceClass: AnnGovernanceEvidenceClass;
  status: "MEASURED" | "INSUFFICIENT_DATA" | "SYNTHETIC_INFRA_ONLY";
  topK: number;
  kValues: number[];
  thresholdDistance: number;
  gallery: {
    entries: number;
    participants: number;
    distractors: number;
    distractorClass: string | null;
    templatePolicy: string;
  };
  probes: { mated: number; nonMated: number };
  exactReference: { mode: "EXACT_IN_MEMORY_TOPK"; description: string };
  falseClearHeadline: Array<{ label: string; observed: number; trials: number; upper95: number | null; claimable: boolean }>;
  configs: AnnConfigResult[];
  limitations: string[];
};

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function summarizeLatency(ms: number[]): LatencySummary {
  const s = [...ms].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    p99: pct(s, 0.99),
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function falseClearMetric(input: {
  observed: number;
  trials: number;
  annRetrievalMiss: number;
  thresholdRejection: number;
  evidenceClass: AnnGovernanceEvidenceClass;
}): FalseClearMetric {
  const ci95 = wilsonInterval95(input.observed, input.trials);
  const claimable = input.evidenceClass === "REAL_HUMAN" && input.trials > 0;
  let statement: string;
  if (input.evidenceClass !== "REAL_HUMAN") {
    statement = `SYNTHETIC: ${input.observed} of ${input.trials} synthetic returning attempts were CLEAR. Not evidence of any real false-CLEAR rate.`;
  } else if (input.trials === 0) {
    statement = "No returning-participant attempts: false CLEAR is UNMEASURED.";
  } else if (input.observed === 0) {
    statement = `0 of ${input.trials} returning attempts were CLEAR (95% upper bound ${(ci95!.high * 100).toFixed(2)}%). Zero observed is not a zero rate.`;
  } else {
    statement = `${input.observed} of ${input.trials} returning attempts were CLEAR (95% CI ${(ci95!.low * 100).toFixed(2)}-${(ci95!.high * 100).toFixed(2)}%).`;
  }
  return {
    observed: input.observed,
    trials: input.trials,
    rate: ratio(input.observed, input.trials),
    ci95,
    byCause: { annRetrievalMiss: input.annRetrievalMiss, thresholdRejection: input.thresholdRejection },
    evidenceClass: input.evidenceClass,
    claimable,
    statement,
  };
}

type Probe = { vector: number[]; mateKey: string | null };

type IdOutcome = "CORRECT" | "WRONG_IDENTITY" | "AMBIGUOUS" | "NO_MATCH";

function identificationOutcome(
  decision: ReturnType<LabIdentificationDecider>,
  mateKey: string | null,
): IdOutcome {
  if (decision.decision === "AMBIGUOUS") return "AMBIGUOUS";
  if (decision.decision === "NO_MATCH") return mateKey == null ? "CORRECT" : "NO_MATCH";
  if (mateKey == null) return "WRONG_IDENTITY";
  return decision.matchedGalleryKey === mateKey ? "CORRECT" : "WRONG_IDENTITY";
}

function attribution(annCorrect: boolean, exactCorrect: boolean): string {
  if (annCorrect && exactCorrect) return "CORRECT";
  if (exactCorrect) return "RETRIEVAL_ERROR";
  if (annCorrect) return "MATCHING_THRESHOLD_ERROR_MASKED_BY_RETRIEVAL";
  return "MATCHING_THRESHOLD_ERROR";
}

async function runConcurrent(
  retriever: LabRetriever,
  probes: number[][],
  topK: number,
  clients: number,
): Promise<ConcurrentRun> {
  const lat: number[] = [];
  let failed = 0;
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async () => {
      for (;;) {
        const i = next++;
        if (i >= probes.length) return;
        const ts = performance.now();
        const outcome = await retrieveOutcome(retriever, probes[i]!, topK);
        if (outcome.status === "ok") lat.push(performance.now() - ts);
        else failed++;
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  return {
    clients,
    queries: lat.length,
    failed,
    qps: seconds > 0 ? lat.length / seconds : 0,
    latencyMs: summarizeLatency(lat),
  };
}

/**
 * Run every retrieval configuration over the same gallery and probes.
 * Mated probes: later-session captures of gallery participants (returning
 * people). Non-mated probes: open-set holdout participants (never enrolled).
 */
export async function evaluateAnnRecallGovernance(input: {
  evidenceClass: AnnGovernanceEvidenceClass;
  galleryCaptures: ComparableCapture[];
  holdoutCaptures: ComparableCapture[];
  configs: AnnGovernanceConfig[];
  decide: LabIdentificationDecider;
  assess: LabDuplicateAssessor;
  thresholdDistance: number;
  topK: number;
  salt: string;
  kValues?: number[];
  distractors?: { entries: LabGalleryEntry[]; distractorClass: string };
  concurrency?: number[];
  onProgress?: (event: { label: string; phase: "start" | "sequential_done" | "done" }) => void;
}): Promise<AnnGovernanceReport> {
  const kValues = input.kValues ?? [1, 5, 10, 50];
  const gallery = buildLabGallery(input.galleryCaptures, input.salt);
  const distractors = input.distractors?.entries ?? [];
  const entries = [...gallery.entries, ...distractors];
  const participantToKey = new Map([...gallery.keyToParticipant.entries()].map(([k, p]) => [p, k]));

  const probes: Probe[] = [];
  for (const c of input.galleryCaptures) {
    if (gallery.enrollmentSessionByParticipant.get(c.participantId) === c.sessionId) continue;
    probes.push({ vector: c.embedding, mateKey: participantToKey.get(c.participantId) ?? null });
  }
  const matedCount = probes.length;
  for (const c of input.holdoutCaptures) probes.push({ vector: c.embedding, mateKey: null });

  const status: AnnGovernanceReport["status"] =
    input.evidenceClass === "SYNTHETIC_FIXTURE"
      ? "SYNTHETIC_INFRA_ONLY"
      : gallery.entries.length < 2 || matedCount === 0
        ? "INSUFFICIENT_DATA"
        : "MEASURED";

  const exact = createExactInMemoryRetriever(entries);
  const exactByProbe: LabRetrievedCandidate[][] = [];
  for (const p of probes) exactByProbe.push(await exact.retrieve([...p.vector], input.topK));
  const expectedReturned = Math.min(input.topK, entries.length);

  const configs: AnnConfigResult[] = [];
  for (const cfg of input.configs) {
    input.onProgress?.({ label: cfg.label, phase: "start" });
    const retriever = await cfg.retrieverFactory(entries);
    const lat: number[] = [];
    const recallHits = Object.fromEntries(kValues.map((k) => [k, 0]));
    const recallDenom = Object.fromEntries(kValues.map((k) => [k, 0]));
    const mateHits = Object.fromEntries(kValues.map((k) => [k, 0]));
    let passingExact = 0;
    let passingMissed = 0;
    let shortResults = 0;
    let returnedTotal = 0;
    let unavailable = 0;
    const matedOutcomes: Record<string, number> = {};
    const matedAttribution: Record<string, number> = {};
    const nonMatedOutcomes: Record<string, number> = {};
    const nonMatedAttribution: Record<string, number> = {};
    const returning = {
      attempts: 0,
      detected: 0,
      ambiguity: 0,
      blockedByOtherIdentity: 0,
      annRetrievalMiss: 0,
      thresholdRejection: 0,
      serviceUnavailable: 0,
    };
    const fresh = { attempts: 0, clear: 0, falseDuplicateReview: 0, ambiguous: 0, serviceUnavailable: 0 };

    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i]!;
      const exactCandidates = exactByProbe[i]!;
      const ts = performance.now();
      const annOutcome: LabRetrievalOutcome = await retrieveOutcome(retriever, probe.vector, input.topK);
      if (annOutcome.status === "ok") lat.push(performance.now() - ts);
      const exactOutcome: LabRetrievalOutcome = { status: "ok", candidates: exactCandidates };

      if (annOutcome.status === "ok") {
        const annKeys = annOutcome.candidates.map((c) => c.galleryKey);
        returnedTotal += annKeys.length;
        if (annKeys.length < expectedReturned) shortResults++;
        const annSet = new Set(annKeys);
        for (const k of kValues) {
          if (k > expectedReturned) continue;
          const truth = exactCandidates.slice(0, k).map((c) => c.galleryKey);
          const got = new Set(annKeys.slice(0, k));
          recallHits[k] += truth.filter((key) => got.has(key)).length;
          recallDenom[k] += truth.length;
          if (probe.mateKey != null && annKeys.slice(0, k).includes(probe.mateKey)) mateHits[k]++;
        }
        for (const c of exactCandidates) {
          if (c.annDistance <= input.thresholdDistance) {
            passingExact++;
            if (!annSet.has(c.galleryKey)) passingMissed++;
          }
        }
        const annDecision = input.decide([...probe.vector], annOutcome.candidates);
        const exactDecision = input.decide([...probe.vector], exactCandidates);
        const annId = identificationOutcome(annDecision, probe.mateKey);
        const exactId = identificationOutcome(exactDecision, probe.mateKey);
        if (probe.mateKey != null) {
          bump(matedOutcomes, annId);
          bump(matedAttribution, attribution(annId === "CORRECT", exactId === "CORRECT"));
        } else {
          bump(nonMatedOutcomes, annId === "CORRECT" ? "CORRECT_REJECTION" : annId === "AMBIGUOUS" ? "AMBIGUOUS_UNKNOWN" : "FALSE_IDENTIFICATION");
          bump(nonMatedAttribution, attribution(annId === "CORRECT", exactId === "CORRECT"));
        }
      } else {
        unavailable++;
        if (probe.mateKey != null) bump(matedOutcomes, "SERVICE_UNAVAILABLE");
        else bump(nonMatedOutcomes, "SERVICE_UNAVAILABLE");
      }

      const gate = input.assess([...probe.vector], annOutcome);
      if (probe.mateKey != null) {
        returning.attempts++;
        if (gate.decision === "SERVICE_UNAVAILABLE") returning.serviceUnavailable++;
        else if (gate.decision === "AMBIGUOUS") returning.ambiguity++;
        else if (gate.decision === "REVIEW_REQUIRED") {
          const keys = gate.candidateGalleryKeys;
          if (!keys || keys.includes(probe.mateKey)) returning.detected++;
          else returning.blockedByOtherIdentity++;
        } else {
          const reference = input.assess([...probe.vector], exactOutcome);
          if (reference.decision === "CLEAR") returning.thresholdRejection++;
          else returning.annRetrievalMiss++;
        }
      } else {
        fresh.attempts++;
        if (gate.decision === "CLEAR") fresh.clear++;
        else if (gate.decision === "AMBIGUOUS") fresh.ambiguous++;
        else if (gate.decision === "SERVICE_UNAVAILABLE") fresh.serviceUnavailable++;
        else fresh.falseDuplicateReview++;
      }
    }

    const matedProbes = Object.values(matedOutcomes).reduce((a, b) => a + b, 0);
    const nonMatedProbes = Object.values(nonMatedOutcomes).reduce((a, b) => a + b, 0);
    const answered = probes.length - unavailable;
    const totalSeconds = lat.reduce((a, b) => a + b, 0) / 1000;
    input.onProgress?.({ label: cfg.label, phase: "sequential_done" });
    const concurrent: ConcurrentRun[] = [];
    for (const clients of input.concurrency ?? []) {
      concurrent.push(await runConcurrent(retriever, probes.map((p) => p.vector), input.topK, clients));
    }
    const falseClearObserved = returning.annRetrievalMiss + returning.thresholdRejection;

    configs.push({
      label: cfg.label,
      efSearch: cfg.efSearch,
      note: cfg.note,
      retrievalMode: retriever.mode,
      retrieval: {
        probes: probes.length,
        recallVsExactAtK: Object.fromEntries(kValues.map((k) => [`K_${k}`, ratio(recallHits[k]!, recallDenom[k]!)])),
        mateRecallAtK: Object.fromEntries(
          kValues.map((k) => [`K_${k}`, k > expectedReturned ? null : ratio(mateHits[k]!, matedCount)]),
        ),
        passingCandidatesExact: passingExact,
        passingCandidatesMissed: passingMissed,
        candidateMissRate: ratio(passingMissed, passingExact),
        shortResultProbes: shortResults,
        meanCandidatesReturned: ratio(returnedTotal, answered),
        unavailable,
      },
      identification: {
        mated: {
          probes: matedProbes,
          outcomes: matedOutcomes,
          matchRate: ratio(matedOutcomes.CORRECT ?? 0, matedProbes),
          ambiguousRate: ratio(matedOutcomes.AMBIGUOUS ?? 0, matedProbes),
          noMatchRate: ratio(matedOutcomes.NO_MATCH ?? 0, matedProbes),
          errorAttribution: matedAttribution,
        },
        nonMated: {
          probes: nonMatedProbes,
          outcomes: nonMatedOutcomes,
          falseIdentificationRate: ratio(nonMatedOutcomes.FALSE_IDENTIFICATION ?? 0, nonMatedProbes),
          ambiguousRate: ratio(nonMatedOutcomes.AMBIGUOUS_UNKNOWN ?? 0, nonMatedProbes),
          noMatchRate: ratio(nonMatedOutcomes.CORRECT_REJECTION ?? 0, nonMatedProbes),
          errorAttribution: nonMatedAttribution,
        },
      },
      duplicateGate: {
        returning: {
          ...returning,
          detectionRate: ratio(returning.detected, returning.attempts),
          blockedRate: ratio(returning.attempts - falseClearObserved, returning.attempts),
        },
        newParticipants: fresh,
      },
      falseClear: falseClearMetric({
        observed: falseClearObserved,
        trials: returning.attempts,
        annRetrievalMiss: returning.annRetrievalMiss,
        thresholdRejection: returning.thresholdRejection,
        evidenceClass: input.evidenceClass,
      }),
      latencyMs: summarizeLatency(lat),
      qps: { sequential: totalSeconds > 0 ? lat.length / totalSeconds : null, concurrent },
    });
    input.onProgress?.({ label: cfg.label, phase: "done" });
  }

  const limitations = [
    "LAB ONLY: no result here changes production ef_search, Top-K, threshold, or any other setting.",
    "Duplicate-gate blocked rate counts SERVICE_UNAVAILABLE and ambiguity as blocked (no identity created); detection rate counts only REVIEW_REQUIRED naming the returning participant.",
    "Non-mated probes are explicit open-set holdout participants only.",
  ];
  if (input.evidenceClass !== "REAL_HUMAN") {
    limitations.unshift("SYNTHETIC FIXTURE: retrieval and plumbing only. Not biometric accuracy, and not a false-CLEAR rate.");
  }
  if (distractors.length) {
    limitations.push(
      `Gallery includes ${distractors.length} distractors (${input.distractors!.distractorClass}); distractor distribution affects recall and is not a real population.`,
    );
  }

  return {
    schemaVersion: ANN_GOVERNANCE_SCHEMA_VERSION,
    resultKind: "EVALUATION_RESULT",
    labOnly: true,
    productionChangeApplied: false,
    evidenceClass: input.evidenceClass,
    status,
    topK: input.topK,
    kValues,
    thresholdDistance: input.thresholdDistance,
    gallery: {
      entries: entries.length,
      participants: gallery.entries.length,
      distractors: distractors.length,
      distractorClass: input.distractors?.distractorClass ?? null,
      templatePolicy: gallery.templatePolicy,
    },
    probes: { mated: matedCount, nonMated: probes.length - matedCount },
    exactReference: {
      mode: "EXACT_IN_MEMORY_TOPK",
      description: "Exhaustive cosine distance over every gallery entry; the ground-truth Top-K each ANN configuration is scored against.",
    },
    falseClearHeadline: configs.map((c) => ({
      label: c.label,
      observed: c.falseClear.observed,
      trials: c.falseClear.trials,
      upper95: c.falseClear.ci95?.high ?? null,
      claimable: c.falseClear.claimable,
    })),
    configs,
    limitations,
  };
}
