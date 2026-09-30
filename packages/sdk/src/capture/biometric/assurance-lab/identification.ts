import { cosineSimilarity } from "../benchmark/metrics.js";
import {
  computeIdentificationDecisionMetrics,
  type IdentificationDecisionMetrics,
  type IdentificationDecisionTrial,
} from "../benchmark/decision-metrics.js";
import { meanNormalizeEmbeddings } from "../face-align.js";
import type { ComparableCapture } from "./pairs.js";

/** Gallery entry keyed by an opaque key; the retriever never sees participant ids. */
export type LabGalleryEntry = { galleryKey: string; embedding: number[] };

export type LabRetrievedCandidate = {
  galleryKey: string;
  annDistance: number;
  vector?: number[];
};

export type LabRetriever = {
  mode: "EXACT_IN_MEMORY_TOPK" | "PGVECTOR_HNSW_TOPK";
  retrieve(probe: number[], topK: number): Promise<LabRetrievedCandidate[]>;
};

export type LabRetrieverFactory = (entries: LabGalleryEntry[]) => Promise<LabRetriever> | LabRetriever;

/** Production decision injected by the caller (exact rerank + threshold + ambiguity). */
export type LabIdentificationDecider = (
  probe: number[],
  candidates: LabRetrievedCandidate[],
) => {
  ranked: Array<{ galleryKey: string; distance: number }>;
  decision: "MATCH" | "AMBIGUOUS" | "NO_MATCH";
  matchedGalleryKey?: string;
};

export type LabRetrievalOutcome =
  | { status: "ok"; candidates: LabRetrievedCandidate[] }
  | { status: "unavailable"; reason: string };

export type LabDuplicateAssessor = (
  probe: number[],
  retrieval: LabRetrievalOutcome,
) => {
  decision: "CLEAR" | "REVIEW_REQUIRED" | "AMBIGUOUS" | "SERVICE_UNAVAILABLE";
  /** Gallery keys that passed threshold (scoring only; never leaves the lab). */
  candidateGalleryKeys?: string[];
};

export async function retrieveOutcome(
  retriever: LabRetriever,
  probe: number[],
  topK: number,
): Promise<LabRetrievalOutcome> {
  try {
    return { status: "ok", candidates: await retriever.retrieve([...probe], topK) };
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : "retrieval_failed" };
  }
}

export function createExactInMemoryRetriever(entries: LabGalleryEntry[]): LabRetriever {
  return {
    mode: "EXACT_IN_MEMORY_TOPK",
    async retrieve(probe, topK) {
      return entries
        .map((e) => ({
          galleryKey: e.galleryKey,
          annDistance: 1 - cosineSimilarity(probe, e.embedding),
          vector: e.embedding,
        }))
        .sort((a, b) => a.annDistance - b.annDistance)
        .slice(0, topK);
    },
  };
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type LabGallery = {
  entries: LabGalleryEntry[];
  /** Scoring-only map; never passed to the retriever or decider. */
  keyToParticipant: Map<string, string>;
  enrollmentSessionByParticipant: Map<string, string>;
  templatePolicy: string;
};

/**
 * Gallery template per participant = L2 mean of that participant's earliest
 * session captures (mirrors multi-frame enrollment). Probes are drawn only
 * from other sessions so same-session frames never inflate recall.
 */
export function buildLabGallery(captures: ComparableCapture[], salt: string): LabGallery {
  const byParticipant = new Map<string, ComparableCapture[]>();
  for (const c of captures) {
    const list = byParticipant.get(c.participantId) ?? [];
    list.push(c);
    byParticipant.set(c.participantId, list);
  }
  const entries: LabGalleryEntry[] = [];
  const keyToParticipant = new Map<string, string>();
  const enrollmentSessionByParticipant = new Map<string, string>();
  for (const [participantId, list] of [...byParticipant.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const firstSession = sorted[0]!.sessionId;
    const template = meanNormalizeEmbeddings(
      sorted.filter((c) => c.sessionId === firstSession).map((c) => c.embedding),
    );
    const galleryKey = `g_${fnv1a(`${salt}:${participantId}`).toString(16).padStart(8, "0")}_${entries.length}`;
    entries.push({ galleryKey, embedding: template });
    keyToParticipant.set(galleryKey, participantId);
    enrollmentSessionByParticipant.set(participantId, firstSession);
  }
  // Shuffle order deterministically so gallery position does not encode identity order.
  entries.sort((a, b) => fnv1a(`${salt}:${a.galleryKey}`) - fnv1a(`${salt}:${b.galleryKey}`));
  return {
    entries,
    keyToParticipant,
    enrollmentSessionByParticipant,
    templatePolicy:
      "Template = L2-normalized mean of the participant's earliest-session captures; probes come from other sessions only.",
  };
}

export type IdentificationOutcome =
  | "CORRECT_IDENTITY"
  | "WRONG_IDENTITY"
  | "AMBIGUOUS"
  | "MATE_IN_TOPK_REJECTED"
  | "NO_MATCH_MATE_NOT_RETRIEVED"
  | "CORRECT_REJECTION"
  | "FALSE_IDENTIFICATION"
  | "AMBIGUOUS_UNKNOWN"
  | "SERVICE_UNAVAILABLE";

export type LabIdentificationReport = {
  retrievalMode: LabRetriever["mode"] | "NOT_RUN";
  topK: number;
  gallerySize: number;
  templatePolicy: string;
  closedSet: {
    probes: number;
    outcomes: Record<string, number>;
    recallAtK: Record<string, { value: number | null; applicable: boolean }>;
    mateInTopKButNotFinal: number;
    metrics: IdentificationDecisionMetrics;
  };
  openSet: {
    method: string;
    probes: number;
    outcomes: Record<string, number>;
    falseIdentificationRate: number | null;
    metrics: IdentificationDecisionMetrics;
  };
  status: "MEASURED" | "INSUFFICIENT_DATA" | "SYNTHETIC_INFRA_ONLY";
};

function tally(outcomes: IdentificationOutcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of outcomes) out[o] = (out[o] ?? 0) + 1;
  return out;
}

/**
 * Closed-set 1:N over gallery participants plus open-set probes that must
 * resolve to NO_MATCH: explicit holdout participants and leave-one-out
 * (each gallery participant probed against a gallery without them).
 */
export async function evaluateIdentification(input: {
  evidenceClass: "REAL_HUMAN" | "SYNTHETIC_FIXTURE";
  galleryCaptures: ComparableCapture[];
  holdoutCaptures: ComparableCapture[];
  retrieverFactory: LabRetrieverFactory;
  decide: LabIdentificationDecider;
  topK: number;
  kValues?: number[];
  salt: string;
  leaveOneOutOpenSet?: boolean;
}): Promise<LabIdentificationReport> {
  const kValues = input.kValues ?? [1, 5, 10, 50];
  const gallery = buildLabGallery(input.galleryCaptures, input.salt);
  const emptyMetrics = computeIdentificationDecisionMetrics([], kValues);
  if (gallery.entries.length < 2) {
    return {
      retrievalMode: "NOT_RUN",
      topK: input.topK,
      gallerySize: gallery.entries.length,
      templatePolicy: gallery.templatePolicy,
      closedSet: {
        probes: 0,
        outcomes: {},
        recallAtK: Object.fromEntries(kValues.map((k) => [`K_${k}`, { value: null, applicable: false }])),
        mateInTopKButNotFinal: 0,
        metrics: emptyMetrics,
      },
      openSet: {
        method: "NOT_RUN",
        probes: 0,
        outcomes: {},
        falseIdentificationRate: null,
        metrics: emptyMetrics,
      },
      status: "INSUFFICIENT_DATA",
    };
  }

  const retriever = await input.retrieverFactory(gallery.entries);
  const closedTrials: IdentificationDecisionTrial[] = [];
  const closedOutcomes: IdentificationOutcome[] = [];
  let mateInTopKButNotFinal = 0;

  const runProbe = async (
    probe: ComparableCapture,
    activeRetriever: LabRetriever,
    expectedParticipant: string | null,
    keyMap: Map<string, string>,
  ): Promise<{ outcome: IdentificationOutcome; trial: IdentificationDecisionTrial; mateInTopK: boolean }> => {
    const t0 = performance.now();
    let candidates: LabRetrievedCandidate[];
    try {
      candidates = await activeRetriever.retrieve([...probe.embedding], input.topK);
    } catch {
      return {
        outcome: "SERVICE_UNAVAILABLE",
        mateInTopK: false,
        trial: {
          evidenceClass: input.evidenceClass,
          expectedIdentityId: expectedParticipant,
          candidateIdentityIds: [],
          decision: "ERROR",
          latencyMs: { candidateRetrieval: performance.now() - t0, reranking: 0, total: performance.now() - t0 },
        },
      };
    }
    const t1 = performance.now();
    const result = input.decide([...probe.embedding], candidates);
    const t2 = performance.now();
    const candidateIds = result.ranked.map((r) => keyMap.get(r.galleryKey) ?? "unknown");
    const matched = result.matchedGalleryKey ? keyMap.get(result.matchedGalleryKey) : undefined;
    const mateInTopK = expectedParticipant != null && candidateIds.includes(expectedParticipant);
    let outcome: IdentificationOutcome;
    if (expectedParticipant == null) {
      outcome =
        result.decision === "MATCH"
          ? "FALSE_IDENTIFICATION"
          : result.decision === "AMBIGUOUS"
            ? "AMBIGUOUS_UNKNOWN"
            : "CORRECT_REJECTION";
    } else if (result.decision === "MATCH") {
      outcome = matched === expectedParticipant ? "CORRECT_IDENTITY" : "WRONG_IDENTITY";
    } else if (result.decision === "AMBIGUOUS") {
      outcome = "AMBIGUOUS";
    } else {
      outcome = mateInTopK ? "MATE_IN_TOPK_REJECTED" : "NO_MATCH_MATE_NOT_RETRIEVED";
    }
    return {
      outcome,
      mateInTopK,
      trial: {
        evidenceClass: input.evidenceClass,
        expectedIdentityId: expectedParticipant,
        candidateIdentityIds: candidateIds,
        decision: result.decision,
        matchedIdentityId: matched,
        latencyMs: { candidateRetrieval: t1 - t0, reranking: t2 - t1, total: t2 - t0 },
      },
    };
  };

  for (const probe of input.galleryCaptures) {
    if (gallery.enrollmentSessionByParticipant.get(probe.participantId) === probe.sessionId) continue;
    const r = await runProbe(probe, retriever, probe.participantId, gallery.keyToParticipant);
    closedOutcomes.push(r.outcome);
    closedTrials.push(r.trial);
    if (r.mateInTopK && r.outcome !== "CORRECT_IDENTITY") mateInTopKButNotFinal++;
  }

  const openOutcomes: IdentificationOutcome[] = [];
  const openTrials: IdentificationDecisionTrial[] = [];
  for (const probe of input.holdoutCaptures) {
    const r = await runProbe(probe, retriever, null, gallery.keyToParticipant);
    openOutcomes.push(r.outcome);
    openTrials.push(r.trial);
  }
  if (input.leaveOneOutOpenSet !== false) {
    const participants = [...new Set(input.galleryCaptures.map((c) => c.participantId))].sort();
    for (const left of participants) {
      const remaining = gallery.entries.filter((e) => gallery.keyToParticipant.get(e.galleryKey) !== left);
      if (remaining.length < 1) continue;
      const looRetriever = await input.retrieverFactory(remaining);
      for (const probe of input.galleryCaptures.filter((c) => c.participantId === left)) {
        const r = await runProbe(probe, looRetriever, null, gallery.keyToParticipant);
        openOutcomes.push(r.outcome);
        openTrials.push(r.trial);
      }
    }
  }

  const closedMetrics = computeIdentificationDecisionMetrics(closedTrials, kValues);
  const recallAtK: Record<string, { value: number | null; applicable: boolean }> = {};
  for (const k of kValues) {
    recallAtK[`K_${k}`] = {
      value: closedMetrics.candidateRecallAtK[`K_${k}`] ?? null,
      applicable: gallery.entries.length >= k && input.topK >= k,
    };
  }
  const falseIds = openOutcomes.filter((o) => o === "FALSE_IDENTIFICATION").length;
  return {
    retrievalMode: retriever.mode,
    topK: input.topK,
    gallerySize: gallery.entries.length,
    templatePolicy: gallery.templatePolicy,
    closedSet: {
      probes: closedTrials.length,
      outcomes: tally(closedOutcomes),
      recallAtK,
      mateInTopKButNotFinal,
      metrics: closedMetrics,
    },
    openSet: {
      method:
        input.leaveOneOutOpenSet !== false
          ? "EXPLICIT_HOLDOUT_PLUS_LEAVE_ONE_PARTICIPANT_OUT"
          : "EXPLICIT_HOLDOUT_ONLY",
      probes: openTrials.length,
      outcomes: tally(openOutcomes),
      falseIdentificationRate: openTrials.length ? falseIds / openTrials.length : null,
      metrics: computeIdentificationDecisionMetrics(openTrials, kValues),
    },
    status:
      input.evidenceClass === "SYNTHETIC_FIXTURE"
        ? "SYNTHETIC_INFRA_ONLY"
        : closedTrials.length === 0
          ? "INSUFFICIENT_DATA"
          : "MEASURED",
  };
}

export type LabDuplicateEnrollmentReport = {
  returningAttempts: number;
  returningFlagged: number;
  returningFalseClear: number;
  newAttempts: number;
  newClear: number;
  newFalseDuplicate: number;
  ambiguous: number;
  serviceUnavailableFailClosed: boolean | null;
  decisions: Record<string, number>;
  status: "MEASURED" | "INSUFFICIENT_DATA" | "SYNTHETIC_INFRA_ONLY";
};

/**
 * Duplicate-enrollment behaviour on lab data:
 * - returning participant (template enrolled, later-session probe) -> expect a duplicate candidate;
 * - participant absent from the gallery (leave-one-out) -> expect CLEAR;
 * - retriever failure -> expect SERVICE_UNAVAILABLE (fail closed).
 * Never merges anything; this only scores decisions.
 */
export async function evaluateDuplicateEnrollment(input: {
  evidenceClass: "REAL_HUMAN" | "SYNTHETIC_FIXTURE";
  galleryCaptures: ComparableCapture[];
  retrieverFactory: LabRetrieverFactory;
  assess: LabDuplicateAssessor;
  topK: number;
  salt: string;
}): Promise<LabDuplicateEnrollmentReport> {
  const gallery = buildLabGallery(input.galleryCaptures, input.salt);
  const decisions: Record<string, number> = {};
  const bump = (d: string) => (decisions[d] = (decisions[d] ?? 0) + 1);
  let returningAttempts = 0;
  let returningFlagged = 0;
  let returningFalseClear = 0;
  let newAttempts = 0;
  let newClear = 0;
  let newFalseDuplicate = 0;
  let ambiguous = 0;

  if (gallery.entries.length >= 2) {
    const full = await input.retrieverFactory(gallery.entries);
    for (const probe of input.galleryCaptures) {
      if (gallery.enrollmentSessionByParticipant.get(probe.participantId) === probe.sessionId) continue;
      const a = input.assess([...probe.embedding], await retrieveOutcome(full, probe.embedding, input.topK));
      bump(a.decision);
      returningAttempts++;
      if (a.decision === "REVIEW_REQUIRED" || a.decision === "AMBIGUOUS") returningFlagged++;
      if (a.decision === "CLEAR") returningFalseClear++;
      if (a.decision === "AMBIGUOUS") ambiguous++;
    }
    for (const left of [...gallery.enrollmentSessionByParticipant.keys()].sort()) {
      const remaining = gallery.entries.filter((e) => gallery.keyToParticipant.get(e.galleryKey) !== left);
      const loo = await input.retrieverFactory(remaining);
      const probe = input.galleryCaptures.find((c) => c.participantId === left)!;
      const a = input.assess([...probe.embedding], await retrieveOutcome(loo, probe.embedding, input.topK));
      bump(a.decision);
      newAttempts++;
      if (a.decision === "CLEAR") newClear++;
      else newFalseDuplicate++;
      if (a.decision === "AMBIGUOUS") ambiguous++;
    }
  }

  let serviceUnavailableFailClosed: boolean | null = null;
  if (input.galleryCaptures.length) {
    const failing: LabRetriever = {
      mode: "EXACT_IN_MEMORY_TOPK",
      retrieve: async () => {
        throw new Error("lab_simulated_index_failure");
      },
    };
    const probe = input.galleryCaptures[0]!.embedding;
    const outcome = input.assess([...probe], await retrieveOutcome(failing, probe, input.topK));
    serviceUnavailableFailClosed = outcome.decision === "SERVICE_UNAVAILABLE";
  }

  return {
    returningAttempts,
    returningFlagged,
    returningFalseClear,
    newAttempts,
    newClear,
    newFalseDuplicate,
    ambiguous,
    serviceUnavailableFailClosed,
    decisions,
    status:
      input.evidenceClass === "SYNTHETIC_FIXTURE"
        ? "SYNTHETIC_INFRA_ONLY"
        : returningAttempts + newAttempts === 0
          ? "INSUFFICIENT_DATA"
          : "MEASURED",
  };
}
