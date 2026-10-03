/**
 * Combined, metadata-only view of the on-device biometric stack. Runtime,
 * detector and embedder are tracked separately so a failure can be
 * attributed without exposing frames, templates or embeddings.
 */
import { getFaceDetectorStatus, type DetectorState } from "./detector-mediapipe.js";
import { getArcFaceEmbedderState, type EmbedderState } from "./recognizer-arcface.js";
import { getOrtRuntimeStatus, type OrtRuntimeStatus } from "./ort-runtime.js";

export type BiometricRuntimeStatus = {
  runtime: OrtRuntimeStatus;
  detector: { state: DetectorState; delegate: string };
  embedder: EmbedderState;
  ready: boolean;
  failed: boolean;
};

export function getBiometricRuntimeStatus(): BiometricRuntimeStatus {
  const runtime = getOrtRuntimeStatus();
  const detector = getFaceDetectorStatus();
  const embedder = getArcFaceEmbedderState();
  return {
    runtime,
    detector,
    embedder,
    ready:
      runtime.state === "READY" &&
      detector.state === "READY" &&
      embedder === "READY",
    failed:
      runtime.state === "FAILED" ||
      detector.state === "FAILED" ||
      embedder === "FAILED",
  };
}
