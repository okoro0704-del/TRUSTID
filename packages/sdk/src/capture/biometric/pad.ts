/**
 * Presentation Attack Detection (PAD) — separate from detection/quality/recognition.
 * Client-supplied liveness scores are never trusted.
 */
import { MediaPipeBlinkPadDetector } from "./pad-blink.js";
import type { FacePadResult, FacePresentationAttackDetector } from "./types.js";

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
 * Production PAD: MediaPipe active blink challenge (model-backed blendshapes).
 * Single still frames without blink history are rejected (fail closed for spoof ease).
 * MiniFASNet print/replay: add under /models/trustid/pad/ in a follow-up.
 */
export function createProductionPadDetector(): FacePresentationAttackDetector {
  return new MediaPipeBlinkPadDetector();
}

export { MediaPipeBlinkPadDetector };
