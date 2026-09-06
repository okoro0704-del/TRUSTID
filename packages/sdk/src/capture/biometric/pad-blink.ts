/**
 * Active blink PAD using MediaPipe Face Landmarker blendshapes.
 * Model-backed active challenge — NOT the heuristic face-presence gate.
 * Does not detect print/replay attacks; MiniFASNet should replace/augment later.
 */
import type { FacePadResult, FacePresentationAttackDetector } from "./types.js";

export class MediaPipeBlinkPadDetector implements FacePresentationAttackDetector {
  readonly modelVersion = "mediapipe_blink_active_v1";
  private eyeOpenHistory: number[] = [];

  /** Feed per-frame average eye-open score (1 - blink). */
  observeBlendshapes(blend: Record<string, number> | undefined) {
    if (!blend) return;
    const blinkL = blend["eyeBlinkLeft"] ?? 0;
    const blinkR = blend["eyeBlinkRight"] ?? 0;
    const open = 1 - (blinkL + blinkR) / 2;
    this.eyeOpenHistory.push(open);
    if (this.eyeOpenHistory.length > 30) this.eyeOpenHistory.shift();
  }

  reset() {
    this.eyeOpenHistory = [];
  }

  async evaluate(): Promise<FacePadResult> {
    if (this.eyeOpenHistory.length < 8) {
      return {
        score: 0,
        decision: "reject",
        modelVersion: this.modelVersion,
        reason: "Insufficient frames for active blink PAD",
      };
    }
    const min = Math.min(...this.eyeOpenHistory);
    const max = Math.max(...this.eyeOpenHistory);
    const delta = max - min;
    // Require a blink-like excursion (eyes close then open)
    if (delta >= 0.25 && min <= 0.55) {
      return {
        score: Math.min(1, delta),
        decision: "accept",
        modelVersion: this.modelVersion,
        reason: "Active blink challenge passed",
      };
    }
    return {
      score: delta,
      decision: "reject",
      modelVersion: this.modelVersion,
      reason: "Active blink challenge failed — blink naturally while looking at the camera",
    };
  }
}
