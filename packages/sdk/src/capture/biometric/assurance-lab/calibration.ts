import { BIOMETRIC_THRESHOLD_POLICY } from "@trustid/shared";
import { ratesAtThreshold } from "../benchmark/metrics.js";
import { farEstimability, wilsonInterval95 } from "../benchmark/stats.js";
import type { VerificationReport } from "../benchmark/types.js";

export type ThresholdSweepRow = {
  thresholdDistance: number;
  fmr: number | null;
  fnmr: number | null;
  tar: number | null;
  trr: number | null;
  falseAccepts: number;
  falseRejects: number;
  trueAccepts: number;
  trueRejects: number;
  fmrCi95: { low: number; high: number } | null;
  fnmrCi95: { low: number; high: number } | null;
  isProductionThreshold: boolean;
};

const round = (x: number, step: number) => Math.round(x / step) * step;

/**
 * Sweep grid derived from observed genuine/impostor distances, padded, and
 * always including the production threshold for comparison.
 */
export function deriveSweepGrid(
  genuineDistances: number[],
  impostorDistances: number[],
  step = 0.01,
  productionThreshold = BIOMETRIC_THRESHOLD_POLICY.threshold,
): number[] {
  const all = [...genuineDistances, ...impostorDistances];
  if (!all.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const d of all) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const lo = Math.max(0, Math.floor((min - 0.05) / step) * step);
  const hi = Math.min(2, Math.ceil((max + 0.05) / step) * step);
  const grid = new Set<number>();
  for (let t = lo; t <= hi + step / 2; t += step) grid.add(Number(round(t, step).toFixed(4)));
  grid.add(productionThreshold);
  return [...grid].sort((a, b) => a - b);
}

/**
 * FMR/FNMR/TAR/TRR per threshold using the existing verification rate function.
 * Scores are cosine distances; acceptance is exactly production's
 * `distance <= threshold` (negation is exact, so `-d >= -t` never drifts).
 */
export function thresholdSweep(
  genuineDistances: number[],
  impostorDistances: number[],
  grid: number[],
  productionThreshold = BIOMETRIC_THRESHOLD_POLICY.threshold,
): ThresholdSweepRow[] {
  const negGenuine = genuineDistances.map((d) => -d);
  const negImpostor = impostorDistances.map((d) => -d);
  return grid.map((thresholdDistance) => {
    const r = ratesAtThreshold(negGenuine, negImpostor, -thresholdDistance);
    const finite = (x: number) => (Number.isFinite(x) ? x : null);
    return {
      thresholdDistance,
      fmr: finite(r.far),
      fnmr: finite(r.frr),
      tar: finite(r.tar),
      trr: finite(r.trr),
      falseAccepts: r.fp,
      falseRejects: r.fn,
      trueAccepts: r.tp,
      trueRejects: r.tn,
      fmrCi95: wilsonInterval95(r.fp, impostorDistances.length),
      fnmrCi95: wilsonInterval95(r.fn, genuineDistances.length),
      isProductionThreshold: thresholdDistance === productionThreshold,
    };
  });
}

export type EvidenceCoverage = {
  participants: number;
  participantsWithMinSessions: number;
  sessions: number;
  captures: number;
  comparableCaptures: number;
  genuinePairs: number;
  crossSessionGenuinePairs: number;
  impostorPairs: number;
  platforms: string[];
  runtimes: string[];
};

export type CalibrationGates = {
  targetFmr: number;
  minParticipants: number;
  minSessionsPerParticipant: number;
  minGenuinePairs: number;
  minPlatforms: number;
};

export type ThresholdRecommendation = {
  status: "CANDIDATE_THRESHOLD" | "INSUFFICIENT_EVIDENCE" | "SYNTHETIC_NOT_ELIGIBLE";
  appliesToProduction: false;
  requiresGovernanceReview: true;
  productionThresholdDistance: number;
  productionThresholdStatus: string;
  candidateThresholdDistance: number | null;
  selectionRule: string;
  developmentMetrics: { fmr: number | null; fnmr: number | null; fmrCi95High: number | null } | null;
  validationMetrics: { fmr: number | null; fnmr: number | null; fmrCi95High: number | null } | null;
  unmetGates: string[];
  coverage: EvidenceCoverage;
  limitations: string[];
};

const SELECTION_RULE =
  "False-match-first: the largest cosine-distance threshold on the development participants whose FMR 95% Wilson upper bound is <= targetFmr; FNMR is reported, not optimised. Checked on subject-disjoint validation participants.";

/**
 * Candidate threshold recommendation. Never changes production; returns
 * INSUFFICIENT_EVIDENCE whenever any evidence gate is unmet.
 */
export function recommendThreshold(input: {
  evidenceClass: "REAL_HUMAN_CONSENTED" | "SYNTHETIC" | null;
  gates: CalibrationGates;
  coverage: EvidenceCoverage;
  development: { genuineDistances: number[]; impostorDistances: number[] };
  validation: { genuineDistances: number[]; impostorDistances: number[] };
  grid: number[];
  padStatus: string;
}): ThresholdRecommendation {
  const { gates, coverage } = input;
  const limitations: string[] = [
    `PAD status is ${input.padStatus}; recognition thresholds do not address presentation attacks.`,
    "Participants are a convenience sample; demographic coverage is not measured by this lab.",
    "Client-produced embeddings are not hardware-attested capture provenance.",
  ];
  const base = {
    appliesToProduction: false as const,
    requiresGovernanceReview: true as const,
    productionThresholdDistance: BIOMETRIC_THRESHOLD_POLICY.threshold,
    productionThresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
    selectionRule: SELECTION_RULE,
    coverage,
    limitations,
  };

  if (input.evidenceClass !== "REAL_HUMAN_CONSENTED") {
    return {
      ...base,
      status: "SYNTHETIC_NOT_ELIGIBLE",
      candidateThresholdDistance: null,
      developmentMetrics: null,
      validationMetrics: null,
      unmetGates: [
        input.evidenceClass === "SYNTHETIC"
          ? "synthetic evidence cannot calibrate a biometric threshold"
          : "no real-human consented evidence",
      ],
    };
  }

  const unmet: string[] = [];
  if (coverage.participants < gates.minParticipants) {
    unmet.push(`participants ${coverage.participants} < ${gates.minParticipants}`);
  }
  if (coverage.participantsWithMinSessions < gates.minParticipants) {
    unmet.push(
      `participants with >= ${gates.minSessionsPerParticipant} sessions ${coverage.participantsWithMinSessions} < ${gates.minParticipants}`,
    );
  }
  if (coverage.genuinePairs < gates.minGenuinePairs) {
    unmet.push(`genuine pairs ${coverage.genuinePairs} < ${gates.minGenuinePairs}`);
  }
  if (coverage.crossSessionGenuinePairs === 0) unmet.push("no cross-session genuine pairs");
  if (coverage.platforms.length < gates.minPlatforms) {
    unmet.push(`platforms ${coverage.platforms.length} < ${gates.minPlatforms}`);
  }
  const devImp = input.development.impostorDistances.length;
  const est = farEstimability(devImp, gates.targetFmr);
  if (est.status !== "ESTIMABLE" || devImp < Math.ceil(3 / gates.targetFmr)) {
    unmet.push(
      `development impostor pairs ${devImp} < ${Math.ceil(3 / gates.targetFmr)} needed to bound FMR ${gates.targetFmr}`,
    );
  }
  if (input.validation.genuineDistances.length === 0 || input.validation.impostorDistances.length === 0) {
    unmet.push("no subject-disjoint validation evidence");
  }

  if (unmet.length) {
    return {
      ...base,
      status: "INSUFFICIENT_EVIDENCE",
      candidateThresholdDistance: null,
      developmentMetrics: null,
      validationMetrics: null,
      unmetGates: unmet,
    };
  }

  const dev = thresholdSweep(
    input.development.genuineDistances,
    input.development.impostorDistances,
    input.grid,
  );
  const eligible = dev.filter((row) => row.fmrCi95 != null && row.fmrCi95.high <= gates.targetFmr);
  const chosen = eligible.length ? eligible[eligible.length - 1]! : null;
  if (!chosen) {
    return {
      ...base,
      status: "INSUFFICIENT_EVIDENCE",
      candidateThresholdDistance: null,
      developmentMetrics: null,
      validationMetrics: null,
      unmetGates: [`no swept threshold bounds FMR <= ${gates.targetFmr} at 95% confidence`],
    };
  }
  const [val] = thresholdSweep(
    input.validation.genuineDistances,
    input.validation.impostorDistances,
    [chosen.thresholdDistance],
  );
  return {
    ...base,
    status: "CANDIDATE_THRESHOLD",
    candidateThresholdDistance: chosen.thresholdDistance,
    developmentMetrics: { fmr: chosen.fmr, fnmr: chosen.fnmr, fmrCi95High: chosen.fmrCi95?.high ?? null },
    validationMetrics: val
      ? { fmr: val.fmr, fnmr: val.fnmr, fmrCi95High: val.fmrCi95?.high ?? null }
      : null,
    unmetGates: [],
  };
}

/** ROC/EER summary from the existing verification report. */
export function summarizeRoc(report: VerificationReport) {
  const eerMeaningful =
    report.status === "MEASURED" && report.genuineCount >= 30 && report.impostorCount >= 300;
  return {
    status: report.status,
    rocPoints: report.roc.map((p) => ({
      thresholdDistance: p.thresholdDistance,
      fmr: p.far,
      tar: p.tar,
    })),
    eer: eerMeaningful ? report.eer : null,
    eerThresholdDistance: eerMeaningful ? report.eerThresholdDistance : null,
    eerStatus: eerMeaningful ? "MEASURED" : "NOT_STATISTICALLY_MEANINGFUL",
  };
}
