/**
 * Assurance Lab service. Evaluation only: reads production biometric policy,
 * reuses the production rerank/threshold/ambiguity and duplicate-assessment
 * code on lab data, and never writes users, TrustIDs, face templates,
 * sessions, or authority.
 */
import { createHash } from "node:crypto";
import {
  BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
  BIOMETRIC_PAD_STATUS,
  BIOMETRIC_THRESHOLD_POLICY,
} from "@trustid/shared";
import type {
  LabDuplicateAssessor,
  LabIdentificationDecider,
  LabRetrievedCandidate,
  LabStudyConfig,
} from "@trustid/sdk/assurance-lab";
import { decideAfterRerank, exactRerankCandidates, type AnnCandidate } from "../trust-id/ann-rerank.js";
import {
  assessDuplicateEnrollmentCandidates,
  unavailableDuplicateEnrollmentAssessment,
} from "../trust-id/duplicate-enrollment.js";
import { biometricRetrievalPolicy } from "../trust-id/retrieval-policy.js";
import { AssuranceLabStore } from "./store.js";

export type LabSdk = typeof import("@trustid/sdk/assurance-lab");

let sdkPromise: Promise<LabSdk> | null = null;

/** Loaded lazily so production processes with the lab disabled never load it. */
export function loadLabSdk(): Promise<LabSdk> {
  sdkPromise ??= import("@trustid/sdk/assurance-lab");
  return sdkPromise;
}

export const DEFAULT_LAB_STUDY_ID = "trustid_dev_study_v1";
export const LAB_TOP_K = 50;

export function labConfigFromEnv() {
  const perStep = Number(process.env.TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP ?? "3");
  const retention = Number(process.env.TRUSTID_ASSURANCE_LAB_RETENTION_DAYS ?? "30");
  return {
    studyId: process.env.TRUSTID_ASSURANCE_LAB_STUDY_ID?.trim() || DEFAULT_LAB_STUDY_ID,
    capturesPerStep: Number.isInteger(perStep) && perStep > 0 ? perStep : 3,
    evidenceRetentionDays: Number.isInteger(retention) && retention > 0 ? retention : 30,
  };
}

/**
 * Study config comes from `<root>/<studyId>/study.json` when an operator has
 * written one; otherwise the development A/B/C template is created with the
 * env-configured captures per step. Invalid configs are refused.
 */
export async function openStudy(): Promise<{ store: AssuranceLabStore; study: LabStudyConfig }> {
  const sdk = await loadLabSdk();
  const cfg = labConfigFromEnv();
  const store = new AssuranceLabStore(cfg.studyId);
  let study = store.readStudy();
  if (!study) {
    study = sdk.buildDevelopmentStudyConfig({
      studyId: cfg.studyId,
      capturesPerStep: cfg.capturesPerStep,
      evidenceRetentionDays: cfg.evidenceRetentionDays,
      sampleSizeRationale:
        "Development protocol: captures per step set by TRUSTID_ASSURANCE_LAB_CAPTURES_PER_STEP. " +
        "Counts are chosen for pipeline coverage, not statistical power; calibration gates decide sufficiency.",
      consentVersion: sdk.LAB_CONSENT_VERSION,
      studyVersion: "1",
    });
    store.writeStudy(study);
  }
  const errors = sdk.validateStudyConfig(study);
  if (errors.length) throw Object.assign(new Error("assurance_lab_invalid_study"), { errors });
  return { store, study };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read-only view of production biometric policy for side-by-side display. */
export function productionConfigurationSnapshot() {
  const override = process.env.FAST_VECTOR_MAX_DISTANCE;
  return {
    source: "@trustid/shared BIOMETRIC_THRESHOLD_POLICY (read-only)",
    thresholdDistance: BIOMETRIC_THRESHOLD_POLICY.threshold,
    thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
    ambiguityMarginDistance: BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
    padStatus: BIOMETRIC_PAD_STATUS.INCOMPLETE,
    runtimeOverride: {
      variable: "FAST_VECTOR_MAX_DISTANCE",
      present: override != null && override !== "",
    },
    retrievalPolicy: biometricRetrievalPolicy(),
    writableFromLab: false as const,
  };
}

function toAnnCandidates(candidates: LabRetrievedCandidate[]): AnnCandidate[] {
  // Lab gallery keys stand in for user/trust/embedding ids inside the
  // production functions only; they are opaque and never leave the lab.
  return candidates.map((c) => ({
    embeddingId: c.galleryKey,
    userId: c.galleryKey,
    trustId: c.galleryKey,
    annDistance: c.annDistance,
    vector: c.vector,
  }));
}

/** Production 1:N decision: exact rerank, then threshold + ambiguity margin. */
export function productionIdentificationDecider(
  thresholdDistance = BIOMETRIC_THRESHOLD_POLICY.threshold,
): LabIdentificationDecider {
  return (probe, candidates) => {
    const ranked = exactRerankCandidates(probe, toAnnCandidates(candidates));
    const d = decideAfterRerank(ranked, thresholdDistance, BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE);
    return {
      ranked: ranked.map((r) => ({ galleryKey: r.userId, distance: r.distance })),
      decision: d.reason === "accept" ? "MATCH" : d.reason === "ambiguous" ? "AMBIGUOUS" : "NO_MATCH",
      matchedGalleryKey: d.accepted?.userId,
    };
  };
}

/** Production duplicate-enrollment assessment, including its fail-closed outage path. */
export function productionDuplicateAssessor(
  thresholdDistance = BIOMETRIC_THRESHOLD_POLICY.threshold,
): LabDuplicateAssessor {
  return (probe, retrieval) => {
    if (retrieval.status === "unavailable") {
      return { decision: unavailableDuplicateEnrollmentAssessment(retrieval.reason).decision };
    }
    const ranked = exactRerankCandidates(probe, toAnnCandidates(retrieval.candidates));
    const assessment = assessDuplicateEnrollmentCandidates(
      ranked,
      thresholdDistance,
      BIOMETRIC_AMBIGUITY_MARGIN_DISTANCE,
    );
    return { decision: assessment.decision, candidateGalleryKeys: assessment.candidateTrustIds };
  };
}

/**
 * Consented evidence for the lab ANN governance experiment: retention applied
 * first, ACTIVE (non-withdrawn) participants only, one evidence class.
 */
export async function annGovernanceCohortFromStore(
  store: AssuranceLabStore,
  study: LabStudyConfig,
  now = new Date(),
) {
  const sdk = await loadLabSdk();
  store.purgeExpired(study.evidenceRetentionDays, now);
  const participants = store.listParticipants().filter((p) => p.status === "ACTIVE");
  const cohort = new Map(participants.map((p) => [p.participantId, p.cohort]));
  const records = store.listCaptures().filter((c) => cohort.has(c.participantId));
  const provenance = sdk.assertSingleEvidenceClass(records);
  const comparable = sdk.comparableCaptures(records);
  return {
    provenance,
    evidenceClass: provenance === "REAL_HUMAN_CONSENTED" ? ("REAL_HUMAN" as const) : ("SYNTHETIC_FIXTURE" as const),
    participants: participants.length,
    galleryCaptures: comparable.filter((c) => cohort.get(c.participantId) !== "OPEN_SET_HOLDOUT"),
    holdoutCaptures: comparable.filter((c) => cohort.get(c.participantId) === "OPEN_SET_HOLDOUT"),
  };
}

export async function buildLabReport(now = new Date()) {
  const sdk = await loadLabSdk();
  const { store, study } = await openStudy();
  store.purgeExpired(study.evidenceRetentionDays, now);
  return sdk.analyzeLabStudy({
    study,
    participants: store.listParticipants(),
    sessions: store.listSessions(),
    captures: store.listCaptures(),
    padAttempts: store.listPadAttempts(),
    retrieverFactory: sdk.createExactInMemoryRetriever,
    decide: productionIdentificationDecider(),
    assessDuplicate: productionDuplicateAssessor(),
    topK: LAB_TOP_K,
    now: () => now,
  });
}
