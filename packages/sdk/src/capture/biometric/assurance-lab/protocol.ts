import type { LabCaptureCondition } from "./types.js";
import { LAB_CAPTURE_CONDITIONS } from "./types.js";

export const LAB_STUDY_SCHEMA = "trustid_assurance_lab_study_v1";

export type LabProtocolStep = {
  key: string;
  title: string;
  guidance: string;
  /** Conditions the operator may label captures in this step with. */
  allowedConditions: LabCaptureCondition[];
  /** Target accepted captures for this step. Set per study; not a statistical constant. */
  targetCaptures: number;
};

export type LabProtocolSession = {
  key: string;
  title: string;
  guidance: string;
  /** Minimum wall-clock gap after the previous protocol session, if any. */
  minimumGapHoursAfterPrevious?: number;
  /** Ask the operator to use a different device/runtime when one is available. */
  preferDifferentDeviceOrRuntime?: boolean;
  steps: LabProtocolStep[];
};

export type LabStudyConfig = {
  schema: typeof LAB_STUDY_SCHEMA;
  studyId: string;
  studyVersion: string;
  title: string;
  consentVersion: string;
  /** Evaluation evidence (embeddings + metadata) retention in days. */
  evidenceRetentionDays: number;
  rawImagePolicy: "TRANSIENT_NOT_RETAINED";
  /** Why the capture counts were chosen; shown on the dashboard. */
  sampleSizeRationale: string;
  sessions: LabProtocolSession[];
  impostorSampling: {
    /** Exhaustive when the cross-participant pair count is <= this cap. */
    exhaustiveCap: number;
    seed: number;
  };
  calibration: {
    /** False-match-first target used for the candidate threshold. */
    targetFmr: number;
    minParticipants: number;
    minSessionsPerParticipant: number;
    minGenuinePairs: number;
    minPlatforms: number;
  };
};

/**
 * Development protocol template. The number of captures per step is an
 * explicit input - the lab does not bake in a sample size.
 */
export function buildDevelopmentStudyConfig(input: {
  studyId: string;
  capturesPerStep: number;
  sampleSizeRationale: string;
  evidenceRetentionDays: number;
  consentVersion: string;
  studyVersion: string;
}): LabStudyConfig {
  const n = input.capturesPerStep;
  return {
    schema: LAB_STUDY_SCHEMA,
    studyId: input.studyId,
    studyVersion: input.studyVersion,
    title: "TrustID biometric development study",
    consentVersion: input.consentVersion,
    evidenceRetentionDays: input.evidenceRetentionDays,
    rawImagePolicy: "TRANSIENT_NOT_RETAINED",
    sampleSizeRationale: input.sampleSizeRationale,
    sessions: [
      {
        key: "SESSION_A",
        title: "Session A - baseline, pose, distance",
        guidance:
          "Normal indoor light. Look at the camera. Then small head turns, then slightly closer/farther.",
        steps: [
          {
            key: "A_BASELINE",
            title: "Baseline",
            guidance: "Face the camera, neutral expression, normal light.",
            allowedConditions: ["NORMAL"],
            targetCaptures: n,
          },
          {
            key: "A_POSE",
            title: "Slight pose variation",
            guidance: "Turn your head slightly left or right while staying in frame.",
            allowedConditions: ["POSE_VARIATION"],
            targetCaptures: n,
          },
          {
            key: "A_DISTANCE",
            title: "Distance variation",
            guidance: "Move slightly closer or farther from the camera.",
            allowedConditions: ["DISTANCE_VARIATION"],
            targetCaptures: n,
          },
        ],
      },
      {
        key: "SESSION_B",
        title: "Session B - repeat baseline, lighting, device",
        guidance:
          "A separate sitting. Repeat the baseline, then a different lighting condition. Use another device or browser if one is available.",
        minimumGapHoursAfterPrevious: 1,
        preferDifferentDeviceOrRuntime: true,
        steps: [
          {
            key: "B_BASELINE",
            title: "Repeat baseline",
            guidance: "Same as the Session A baseline.",
            allowedConditions: ["REPEAT_BASELINE"],
            targetCaptures: n,
          },
          {
            key: "B_LIGHTING",
            title: "Lighting variation",
            guidance: "Label exactly the lighting you used.",
            allowedConditions: ["LOW_LIGHT", "BRIGHT_LIGHT", "SIDE_LIGHT"],
            targetCaptures: n,
          },
        ],
      },
      {
        key: "SESSION_C",
        title: "Session C - later repeat",
        guidance: "At least a day later. Repeat the baseline; optional expression/glasses.",
        minimumGapHoursAfterPrevious: 24,
        steps: [
          {
            key: "C_BASELINE",
            title: "Later repeat baseline",
            guidance: "Same as the Session A baseline.",
            allowedConditions: ["REPEAT_BASELINE"],
            targetCaptures: n,
          },
          {
            key: "C_VARIATION",
            title: "Expression / glasses",
            guidance: "Natural expression change, or glasses on/off if you wear them.",
            allowedConditions: ["EXPRESSION_VARIATION", "GLASSES"],
            targetCaptures: n,
          },
        ],
      },
    ],
    impostorSampling: { exhaustiveCap: 5_000_000, seed: 20260929 },
    calibration: {
      targetFmr: 1e-4,
      minParticipants: 50,
      minSessionsPerParticipant: 2,
      minGenuinePairs: 1_000,
      minPlatforms: 2,
    },
  };
}

export function validateStudyConfig(config: LabStudyConfig): string[] {
  const errors: string[] = [];
  if (config.schema !== LAB_STUDY_SCHEMA) errors.push("unsupported study schema");
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(config.studyId)) errors.push("studyId must be 3-64 safe characters");
  if (config.rawImagePolicy !== "TRANSIENT_NOT_RETAINED") {
    errors.push("raw image retention requires a separate consent class and is not supported");
  }
  if (!Number.isInteger(config.evidenceRetentionDays) || config.evidenceRetentionDays < 1) {
    errors.push("evidenceRetentionDays must be a positive integer");
  }
  if (!config.sampleSizeRationale.trim()) errors.push("sampleSizeRationale is required");
  if (!config.sessions.length) errors.push("at least one protocol session is required");
  const sessionKeys = new Set<string>();
  const stepKeys = new Set<string>();
  for (const session of config.sessions) {
    if (sessionKeys.has(session.key)) errors.push(`duplicate session key ${session.key}`);
    sessionKeys.add(session.key);
    if (!session.steps.length) errors.push(`session ${session.key} has no steps`);
    for (const step of session.steps) {
      if (stepKeys.has(step.key)) errors.push(`duplicate step key ${step.key}`);
      stepKeys.add(step.key);
      if (!Number.isInteger(step.targetCaptures) || step.targetCaptures < 1) {
        errors.push(`step ${step.key} targetCaptures must be a positive integer`);
      }
      if (!step.allowedConditions.length) errors.push(`step ${step.key} has no allowed conditions`);
      for (const c of step.allowedConditions) {
        if (!(LAB_CAPTURE_CONDITIONS as readonly string[]).includes(c)) {
          errors.push(`step ${step.key} has unknown condition ${c}`);
        }
      }
    }
  }
  const cal = config.calibration;
  if (!(cal.targetFmr > 0 && cal.targetFmr < 1)) errors.push("calibration.targetFmr must be in (0,1)");
  if (cal.minParticipants < 2) errors.push("calibration.minParticipants must be >= 2");
  if (config.impostorSampling.exhaustiveCap < 1) errors.push("impostorSampling.exhaustiveCap must be >= 1");
  return errors;
}

export function findProtocolStep(
  config: LabStudyConfig,
  sessionKey: string,
  stepKey: string,
): { session: LabProtocolSession; step: LabProtocolStep } | null {
  const session = config.sessions.find((s) => s.key === sessionKey);
  const step = session?.steps.find((s) => s.key === stepKey);
  return session && step ? { session, step } : null;
}
