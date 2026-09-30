import { wilsonInterval95 } from "../benchmark/stats.js";
import type { LabEnvironment } from "./types.js";

/**
 * Presentation classes the lab records. Attack media are prepared and labelled
 * by the operator; the lab only records the defensive outcome.
 */
export const LAB_PAD_PRESENTATIONS = [
  "BONA_FIDE_LIVE",
  "STATIC_PHOTO",
  "SCREEN_DISPLAY",
  "PRERECORDED_VIDEO",
] as const;
export type LabPadPresentation = (typeof LAB_PAD_PRESENTATIONS)[number];

export type LabPadAttempt = {
  schemaVersion: "trustid_assurance_lab_pad_attempt_v1";
  resultKind: "EVALUATION_RESULT";
  attemptId: string;
  studyId: string;
  participantId: string;
  sessionId: string;
  presentation: LabPadPresentation;
  expected: "PASS" | "REJECT";
  padDecision: "PASS" | "REJECT" | "UNAVAILABLE" | "NOT_RUN";
  padMethod: string;
  challengeResult: "PASSED" | "FAILED" | "TIMEOUT" | "NOT_ISSUED";
  qualityDecision: "PASS" | "REJECT";
  environment: LabEnvironment;
  recordedAt: string;
  rawMediaRetained: false;
};

export function expectedPadDecision(presentation: LabPadPresentation): "PASS" | "REJECT" {
  return presentation === "BONA_FIDE_LIVE" ? "PASS" : "REJECT";
}

export type LabPadReport = {
  bonaFide: {
    attempts: number;
    decided: number;
    rejected: number;
    bpcer: number | null;
    bpcerCi95: { low: number; high: number } | null;
  };
  attackClasses: Record<
    string,
    {
      attempts: number;
      decided: number;
      accepted: number;
      apcer: number | null;
      apcerCi95: { low: number; high: number } | null;
    }
  >;
  maxApcer: number | null;
  undecidedAttempts: number;
  status: "NO_DATA" | "INSUFFICIENT_DATA" | "EVALUATED";
  productionReady: false;
  statusReason: string;
};

/**
 * ISO/IEC 30107-3 style rates: APCER per attack class (attacks classified as
 * bona fide), BPCER (bona fide classified as attack). UNAVAILABLE/NOT_RUN are
 * reported separately and never counted as a successful defence.
 */
export function computePadReport(
  attempts: LabPadAttempt[],
  gates = { minBonaFide: 100, minPerAttackClass: 100 },
): LabPadReport {
  const decided = (a: LabPadAttempt) => a.padDecision === "PASS" || a.padDecision === "REJECT";
  const bona = attempts.filter((a) => a.presentation === "BONA_FIDE_LIVE");
  const bonaDecided = bona.filter(decided);
  const bonaRejected = bonaDecided.filter((a) => a.padDecision === "REJECT").length;
  const attackClasses: LabPadReport["attackClasses"] = {};
  let maxApcer: number | null = null;
  for (const cls of LAB_PAD_PRESENTATIONS.filter((p) => p !== "BONA_FIDE_LIVE")) {
    const list = attempts.filter((a) => a.presentation === cls);
    const d = list.filter(decided);
    const accepted = d.filter((a) => a.padDecision === "PASS").length;
    const apcer = d.length ? accepted / d.length : null;
    if (apcer != null) maxApcer = Math.max(maxApcer ?? 0, apcer);
    attackClasses[cls] = {
      attempts: list.length,
      decided: d.length,
      accepted,
      apcer,
      apcerCi95: wilsonInterval95(accepted, d.length),
    };
  }
  const undecided = attempts.filter((a) => !decided(a)).length;
  const enough =
    bonaDecided.length >= gates.minBonaFide &&
    Object.values(attackClasses).every((c) => c.decided >= gates.minPerAttackClass);
  const status = attempts.length === 0 ? "NO_DATA" : enough ? "EVALUATED" : "INSUFFICIENT_DATA";
  return {
    bonaFide: {
      attempts: bona.length,
      decided: bonaDecided.length,
      rejected: bonaRejected,
      bpcer: bonaDecided.length ? bonaRejected / bonaDecided.length : null,
      bpcerCi95: wilsonInterval95(bonaRejected, bonaDecided.length),
    },
    attackClasses,
    maxApcer,
    undecidedAttempts: undecided,
    status,
    productionReady: false,
    statusReason:
      "Current PAD is active blink liveness only. Mask, deepfake, and injected-camera classes are not evaluated, " +
      "so no lab result can mark PAD production-ready.",
  };
}
