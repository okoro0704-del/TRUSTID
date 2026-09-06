/**
 * Presentation Attack Detection (PAD) — separate from detection / quality / recognition.
 *
 * PAD_STATUS = INCOMPLETE until a validated print/replay/mask model is deployed.
 * Active blink is ACTIVE LIVENESS only — not complete anti-spoofing.
 */
import { BIOMETRIC_PAD_STATUS } from "@trustid/shared";
import { MediaPipeBlinkPadDetector } from "./pad-blink.js";
import type { FacePadResult, FacePresentationAttackDetector } from "./types.js";

export const PAD_STATUS = BIOMETRIC_PAD_STATUS.INCOMPLETE;

export type FormalPadResult = {
  pass: boolean;
  fail: boolean;
  unavailable: boolean;
  confidence: number;
  method: string;
  modelVersion: string;
  /** Explicit product status — never claim complete PAD from blink alone */
  padStatus: typeof BIOMETRIC_PAD_STATUS[keyof typeof BIOMETRIC_PAD_STATUS];
  reason: string;
};

export function toFormalPadResult(r: FacePadResult): FormalPadResult {
  return {
    pass: r.decision === "accept",
    fail: r.decision === "reject",
    unavailable: r.decision === "unavailable",
    confidence: r.score,
    method: r.modelVersion.startsWith("mediapipe_blink")
      ? "active_blink_liveness"
      : r.modelVersion,
    modelVersion: r.modelVersion,
    padStatus: PAD_STATUS,
    reason: r.reason,
  };
}

/**
 * Fail-closed PAD when no active challenge history and no MiniFASNet artifact.
 */
export class FailClosedPadDetector implements FacePresentationAttackDetector {
  readonly modelVersion = "pad_unavailable_v0";

  async evaluate(): Promise<FacePadResult> {
    return {
      score: 0,
      decision: "unavailable",
      modelVersion: this.modelVersion,
      reason:
        "No production PAD model loaded. Face enrollment/authentication is fail-closed until PAD is available.",
    };
  }
}

/**
 * DEV/TEST only — never use for production identity decisions.
 */
export class DevBypassPadDetector implements FacePresentationAttackDetector {
  readonly modelVersion = "pad_dev_bypass_v0";

  async evaluate(): Promise<FacePadResult> {
    return {
      score: 1,
      decision: "accept",
      modelVersion: this.modelVersion,
      reason: "DEV_BYPASS_ONLY — not a real liveness decision",
    };
  }
}

/**
 * Production active-liveness: MediaPipe blink challenge.
 * Does NOT prevent print/replay/screen/3D-mask/deepfake attacks.
 * MiniFASNet (or equivalent) remains NOT IMPLEMENTED / not present in artifacts.
 */
export function createProductionPadDetector(): FacePresentationAttackDetector {
  return new MediaPipeBlinkPadDetector();
}

export function getPadDeploymentStatus(): {
  padStatus: typeof PAD_STATUS;
  blinkLiveness: "ACTIVE";
  miniFasNet: "NOT_PRESENT";
  claimsForbidden: string[];
} {
  return {
    padStatus: PAD_STATUS,
    blinkLiveness: "ACTIVE",
    miniFasNet: "NOT_PRESENT",
    claimsForbidden: [
      "replay attacks",
      "printed-photo attacks",
      "screen attacks",
      "3D-mask attacks",
      "deepfake/video injection attacks",
    ],
  };
}

export { MediaPipeBlinkPadDetector };
