import { cosineSimilarity } from "../benchmark/metrics.js";
import type { LabCaptureRecord, LabPairRecord } from "./types.js";

export type ComparableCapture = LabCaptureRecord & { embedding: number[] };

/** Captures that produced an embedding. Quality rejects are failure-to-acquire, not pairs. */
export function comparableCaptures(records: LabCaptureRecord[]): ComparableCapture[] {
  return records
    .filter((r): r is ComparableCapture => r.quality.decision === "PASS" && Array.isArray(r.embedding))
    .sort(
      (a, b) =>
        a.participantId.localeCompare(b.participantId) ||
        a.capturedAt.localeCompare(b.capturedAt) ||
        a.captureId.localeCompare(b.captureId),
    );
}

function sameRuntimeAndDevice(a: LabCaptureRecord, b: LabCaptureRecord): boolean {
  return (
    a.environment.platform === b.environment.platform &&
    a.environment.runtime === b.environment.runtime &&
    (a.environment.deviceModel ?? "") === (b.environment.deviceModel ?? "") &&
    a.environment.deviceClass === b.environment.deviceClass
  );
}

function pairRecord(a: ComparableCapture, b: ComparableCapture): LabPairRecord {
  const similarity = cosineSimilarity(a.embedding, b.embedding);
  return {
    captureA: a.captureId,
    captureB: b.captureId,
    participantA: a.participantId,
    participantB: b.participantId,
    genuine: a.participantId === b.participantId,
    similarity,
    distance: 1 - similarity,
    sameSession: a.sessionId === b.sessionId,
    crossRuntimeOrDevice: !sameRuntimeAndDevice(a, b),
    probeConditions: b.conditions,
  };
}

/**
 * Every unordered same-participant pair. No filtering on score - genuine
 * pairs are never cherry-picked.
 */
export function generateGenuinePairs(captures: ComparableCapture[]): LabPairRecord[] {
  const byParticipant = new Map<string, ComparableCapture[]>();
  for (const c of captures) {
    const list = byParticipant.get(c.participantId) ?? [];
    list.push(c);
    byParticipant.set(c.participantId, list);
  }
  const pairs: LabPairRecord[] = [];
  for (const id of [...byParticipant.keys()].sort()) {
    const list = byParticipant.get(id)!;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pairs.push(pairRecord(list[i]!, list[j]!));
    }
  }
  return pairs;
}

export type ImpostorSamplingPolicy = {
  exhaustiveCap: number;
  seed: number;
};

export type ImpostorSamplingSummary = {
  method: "EXHAUSTIVE" | "SEEDED_UNIFORM_WITHOUT_REPLACEMENT" | "NONE";
  totalCrossParticipantPairs: number;
  evaluatedPairs: number;
  seed: number | null;
  description: string;
};

export function countCrossParticipantPairs(captures: ComparableCapture[]): number {
  const counts = new Map<string, number>();
  for (const c of captures) counts.set(c.participantId, (counts.get(c.participantId) ?? 0) + 1);
  const n = captures.length;
  let same = 0;
  for (const k of counts.values()) same += (k * (k - 1)) / 2;
  return (n * (n - 1)) / 2 - same;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cross-participant pairs. Exhaustive when the total fits the cap; otherwise a
 * seeded uniform sample over all cross-participant pairs (no score-based
 * selection). The callback form avoids materialising millions of pairs.
 */
export function forEachImpostorPair(
  captures: ComparableCapture[],
  policy: ImpostorSamplingPolicy,
  visit: (pair: LabPairRecord) => void,
): ImpostorSamplingSummary {
  const total = countCrossParticipantPairs(captures);
  if (total === 0) {
    return {
      method: "NONE",
      totalCrossParticipantPairs: 0,
      evaluatedPairs: 0,
      seed: null,
      description: "Fewer than two participants with comparable captures.",
    };
  }
  if (total <= policy.exhaustiveCap) {
    let evaluated = 0;
    for (let i = 0; i < captures.length; i++) {
      for (let j = i + 1; j < captures.length; j++) {
        if (captures[i]!.participantId === captures[j]!.participantId) continue;
        visit(pairRecord(captures[i]!, captures[j]!));
        evaluated++;
      }
    }
    return {
      method: "EXHAUSTIVE",
      totalCrossParticipantPairs: total,
      evaluatedPairs: evaluated,
      seed: null,
      description: "Every cross-participant capture pair was compared.",
    };
  }
  const rand = mulberry32(policy.seed);
  const seen = new Set<string>();
  let evaluated = 0;
  const maxAttempts = policy.exhaustiveCap * 20;
  for (let attempt = 0; evaluated < policy.exhaustiveCap && attempt < maxAttempts; attempt++) {
    let i = Math.floor(rand() * captures.length);
    let j = Math.floor(rand() * captures.length);
    if (i === j || captures[i]!.participantId === captures[j]!.participantId) continue;
    if (i > j) [i, j] = [j, i];
    const key = `${i}:${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    visit(pairRecord(captures[i]!, captures[j]!));
    evaluated++;
  }
  return {
    method: "SEEDED_UNIFORM_WITHOUT_REPLACEMENT",
    totalCrossParticipantPairs: total,
    evaluatedPairs: evaluated,
    seed: policy.seed,
    description: `Uniform sample of ${evaluated} of ${total} cross-participant pairs (seed ${policy.seed}); no score-based selection.`,
  };
}
