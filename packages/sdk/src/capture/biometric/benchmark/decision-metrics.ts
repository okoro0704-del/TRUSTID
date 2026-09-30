export type IdentificationDecisionTrial = {
  evidenceClass: "REAL_HUMAN" | "SYNTHETIC_FIXTURE";
  expectedIdentityId: string | null;
  candidateIdentityIds: string[];
  decision: "MATCH" | "AMBIGUOUS" | "NO_MATCH" | "ERROR";
  matchedIdentityId?: string;
  latencyMs: {
    candidateRetrieval: number;
    reranking: number;
    total: number;
  };
};

export type IdentificationDecisionMetrics = {
  evidenceClass: "REAL_HUMAN" | "SYNTHETIC_FIXTURE" | "MIXED";
  trialCount: number;
  ambiguousRate: number | null;
  noMatchRate: number | null;
  candidateRecallAtK: Record<string, number | null>;
  latencyMs: {
    candidateRetrieval: { p50: number | null; p95: number | null; p99: number | null };
    reranking: { p50: number | null; p95: number | null; p99: number | null };
    total: { p50: number | null; p95: number | null; p99: number | null };
  };
  biometricAccuracyStatus: "REAL_HUMAN_EVIDENCE" | "SYNTHETIC_INFRA_ONLY" | "NO_DATA";
};

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}

export function computeIdentificationDecisionMetrics(
  trials: IdentificationDecisionTrial[],
  kValues = [1, 5, 10, 50, 100],
): IdentificationDecisionMetrics {
  const evidence = new Set(trials.map((trial) => trial.evidenceClass));
  const evidenceClass = evidence.size > 1 ? "MIXED" : (trials[0]?.evidenceClass ?? "SYNTHETIC_FIXTURE");
  const genuine = trials.filter((trial) => trial.expectedIdentityId != null);
  const candidateRecallAtK: Record<string, number | null> = {};
  for (const k of kValues) {
    candidateRecallAtK[`K_${k}`] = genuine.length
      ? genuine.filter((trial) =>
          trial.candidateIdentityIds.slice(0, k).includes(trial.expectedIdentityId!),
        ).length / genuine.length
      : null;
  }
  const latency = (key: keyof IdentificationDecisionTrial["latencyMs"]) => {
    const values = trials.map((trial) => trial.latencyMs[key]).filter(Number.isFinite);
    return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
  };
  return {
    evidenceClass,
    trialCount: trials.length,
    ambiguousRate: trials.length ? trials.filter((trial) => trial.decision === "AMBIGUOUS").length / trials.length : null,
    noMatchRate: trials.length ? trials.filter((trial) => trial.decision === "NO_MATCH").length / trials.length : null,
    candidateRecallAtK,
    latencyMs: {
      candidateRetrieval: latency("candidateRetrieval"),
      reranking: latency("reranking"),
      total: latency("total"),
    },
    biometricAccuracyStatus:
      trials.length === 0
        ? "NO_DATA"
        : evidenceClass === "REAL_HUMAN"
          ? "REAL_HUMAN_EVIDENCE"
          : "SYNTHETIC_INFRA_ONLY",
  };
}
