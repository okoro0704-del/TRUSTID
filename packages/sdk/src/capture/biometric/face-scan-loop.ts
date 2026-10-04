/**
 * Face scan loop: sample frames at a controlled cadence, detect, gate, embed,
 * keep the best valid candidate, and report a precise reason when none passes.
 *
 * Camera/video readiness lives in silent-camera-web.ts; this module only sees
 * frames that already exist. One detector or embedder call runs at a time.
 * Never logs frames, landmarks or embeddings.
 */
import {
  BIOMETRIC_ERROR_CODES,
  FACE_SCAN_REASON,
  type BiometricErrorCode,
  type FaceScanCounters,
  type FaceScanDiagnostics,
  type FaceScanReason,
} from "@trustid/shared";
import type { DetectionResult } from "./detector-mediapipe.js";
import { faceCaptureDiag, summarizeImageDataSignal } from "./face-capture-diag.js";
import type { FaceCandidate } from "./pipeline.js";
import type {
  AIVectorPayload,
  BiometricExtractError,
  BiometricExtractResult,
} from "./types.js";

export const FACE_SCAN_STATE = {
  IDLE: "IDLE",
  REQUESTING_CAMERA: "REQUESTING_CAMERA",
  CAMERA_GRANTED: "CAMERA_GRANTED",
  WAITING_FOR_VIDEO: "WAITING_FOR_VIDEO",
  VIDEO_READY: "VIDEO_READY",
  WAITING_FOR_FRAME: "WAITING_FOR_FRAME",
  FRAME_READY: "FRAME_READY",
  /** First frame exists; waiting for detector + embedder to be ready. */
  PREPARING_MODELS: "PREPARING_MODELS",
  DETECTING: "DETECTING",
  FACE_DETECTED: "FACE_DETECTED",
  QUALITY_ACCEPTED: "QUALITY_ACCEPTED",
  EMBEDDING: "EMBEDDING",
  COMPLETE: "COMPLETE",
  FAILED: "FAILED",
} as const;

export type FaceScanState = (typeof FACE_SCAN_STATE)[keyof typeof FACE_SCAN_STATE];

/** Frames darker than this mean luma never reach the detector. */
export const DARK_FRAME_MEAN_LUMA = 12;

export type ScanFrame = {
  imageData: ImageData;
  /** Identifies the source frame; an equal id means the same (stale) frame. */
  frameId: number;
};

export type FaceScanDeps = {
  /** Resolve the next fresh frame, or null when none arrived in time. */
  nextFrame: () => Promise<ScanFrame | null>;
  detect: (imageData: ImageData) => Promise<DetectionResult>;
  evaluate: (
    imageData: ImageData,
    detection: DetectionResult,
  ) => FaceCandidate | BiometricExtractError;
  embed: (imageData: ImageData, candidate: FaceCandidate) => Promise<BiometricExtractResult>;
  onDetection?: (detection: DetectionResult) => void;
  onState?: (state: FaceScanState) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type FaceScanOptions = {
  signal?: AbortSignal;
  /** Sampling window after the first frame is ready. */
  budgetMs: number;
  /** Minimum time between detector submissions (mobile CPU cadence). */
  minIntervalMs?: number;
  /** Confidence at which a candidate completes the scan immediately. */
  acceptConfidence: number;
};

export type FaceScanOutcome =
  | { ok: true; payload: AIVectorPayload; diagnostics: FaceScanDiagnostics }
  | {
      ok: false;
      reason: FaceScanReason;
      code: BiometricErrorCode;
      message: string;
      diagnostics: FaceScanDiagnostics;
    };

export function emptyFaceScanCounters(): FaceScanCounters {
  return {
    framesObserved: 0,
    framesSubmitted: 0,
    blankFrames: 0,
    darkFrames: 0,
    staleFrames: 0,
    detectorSuccesses: 0,
    detectorErrors: 0,
    facesDetected: 0,
    multipleFaces: 0,
    qualityAccepted: 0,
    qualityRejected: 0,
    embeddingAttempts: 0,
    embeddingFailures: 0,
  };
}

const QUALITY_REASONS: readonly FaceScanReason[] = [
  FACE_SCAN_REASON.FACE_TOO_SMALL,
  FACE_SCAN_REASON.FACE_OUT_OF_BOUNDS,
  FACE_SCAN_REASON.LOW_LIGHT,
  FACE_SCAN_REASON.OVEREXPOSED,
  FACE_SCAN_REASON.EXCESSIVE_BLUR,
  FACE_SCAN_REASON.POSE_REJECTED,
];

const REASON_MESSAGES: Record<FaceScanReason, string> = {
  CAMERA_UNAVAILABLE: "Camera unavailable",
  NO_VIDEO_FRAME: "Camera granted but no video frames arrived",
  MODELS_NOT_READY: "Face models were not ready in time",
  NO_FACE_DETECTED: "No face found in the camera view",
  MULTIPLE_FACES: "More than one face in view",
  FACE_TOO_SMALL: "Face too far from the camera",
  FACE_OUT_OF_BOUNDS: "Face partly outside the camera view",
  LOW_LIGHT: "Too dark to read the face",
  OVEREXPOSED: "Too much light on the face",
  EXCESSIVE_BLUR: "Face image too blurry",
  POSE_REJECTED: "Face turned away from the camera",
  DETECTOR_ERROR: "Face detector failed on every frame",
  FACE_CROP_FAILED: "Face crop failed",
  EMBEDDING_FAILED: "Face recognizer failed",
  LIVENESS_NOT_CONFIRMED: "Blink to confirm liveness, then try again",
  SCAN_TIMEOUT: "Face scan timed out",
  SCAN_ABORTED: "Capture aborted",
};

export function faceScanReasonMessage(reason: FaceScanReason): string {
  return REASON_MESSAGES[reason];
}

/** Map a precise scan reason onto the stable public biometric error code. */
export function faceScanReasonToErrorCode(reason: FaceScanReason): BiometricErrorCode {
  switch (reason) {
    case FACE_SCAN_REASON.CAMERA_UNAVAILABLE:
    case FACE_SCAN_REASON.NO_VIDEO_FRAME:
      return BIOMETRIC_ERROR_CODES.CAMERA_UNAVAILABLE;
    case FACE_SCAN_REASON.MODELS_NOT_READY:
      return BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE;
    case FACE_SCAN_REASON.MULTIPLE_FACES:
      return BIOMETRIC_ERROR_CODES.MULTIPLE_FACES;
    case FACE_SCAN_REASON.FACE_TOO_SMALL:
      return BIOMETRIC_ERROR_CODES.FACE_TOO_SMALL;
    case FACE_SCAN_REASON.FACE_OUT_OF_BOUNDS:
    case FACE_SCAN_REASON.LOW_LIGHT:
    case FACE_SCAN_REASON.OVEREXPOSED:
    case FACE_SCAN_REASON.EXCESSIVE_BLUR:
    case FACE_SCAN_REASON.POSE_REJECTED:
      return BIOMETRIC_ERROR_CODES.LOW_QUALITY;
    case FACE_SCAN_REASON.DETECTOR_ERROR:
      return BIOMETRIC_ERROR_CODES.DETECTOR_ERROR;
    case FACE_SCAN_REASON.FACE_CROP_FAILED:
    case FACE_SCAN_REASON.EMBEDDING_FAILED:
      return BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED;
    case FACE_SCAN_REASON.LIVENESS_NOT_CONFIRMED:
      return BIOMETRIC_ERROR_CODES.LIVENESS_FAILED;
    default:
      return BIOMETRIC_ERROR_CODES.NO_FACE;
  }
}

/**
 * The furthest pipeline stage that frames reached decides the reason: a face
 * that failed quality is more informative than earlier frames with no face.
 */
export function dominantFaceScanReason(
  c: FaceScanCounters,
  rejections: Partial<Record<FaceScanReason, number>>,
): FaceScanReason | null {
  if (c.embeddingFailures > 0) return FACE_SCAN_REASON.EMBEDDING_FAILED;
  if ((rejections.FACE_CROP_FAILED ?? 0) > 0) return FACE_SCAN_REASON.FACE_CROP_FAILED;
  let best: FaceScanReason | null = null;
  let bestCount = 0;
  for (const r of QUALITY_REASONS) {
    const n = rejections[r] ?? 0;
    if (n > bestCount) {
      best = r;
      bestCount = n;
    }
  }
  if (best) return best;
  if (c.multipleFaces > 0) return FACE_SCAN_REASON.MULTIPLE_FACES;
  if (c.detectorSuccesses > 0) return FACE_SCAN_REASON.NO_FACE_DETECTED;
  if (c.detectorErrors > 0) return FACE_SCAN_REASON.DETECTOR_ERROR;
  if (c.darkFrames > 0) return FACE_SCAN_REASON.LOW_LIGHT;
  if (c.framesObserved > 0 || c.staleFrames > 0) return FACE_SCAN_REASON.NO_VIDEO_FRAME;
  return null;
}

function orientationOf(w: number, h: number): FaceScanDiagnostics["orientation"] {
  if (w === h) return "square";
  return h > w ? "portrait" : "landscape";
}

const MODEL_UNAVAILABLE = /unavailable|integrity|missing/i;

export async function runFaceScanLoop(
  deps: FaceScanDeps,
  options: FaceScanOptions,
): Promise<FaceScanOutcome> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const counters = emptyFaceScanCounters();
  const rejections: Partial<Record<FaceScanReason, number>> = {};
  const started = now();
  const minInterval = options.minIntervalMs ?? 0;
  let state: FaceScanState = FACE_SCAN_STATE.WAITING_FOR_FRAME;
  let best: AIVectorPayload | null = null;
  let lastSubmitAt = Number.NEGATIVE_INFINITY;
  let lastFrameId: number | null = null;
  let detectorInput: { width: number; height: number } | undefined;
  let frameDims: { width: number; height: number } | undefined;
  let meanLuma: number | undefined;

  const setState = (next: FaceScanState) => {
    state = next;
    deps.onState?.(next);
  };

  const diagnostics = (reason?: FaceScanReason): FaceScanDiagnostics => ({
    reason,
    finalState: state,
    counters: { ...counters },
    videoWidth: frameDims?.width,
    videoHeight: frameDims?.height,
    detectorInputWidth: detectorInput?.width,
    detectorInputHeight: detectorInput?.height,
    orientation: frameDims ? orientationOf(frameDims.width, frameDims.height) : undefined,
    inferenceMirrored: false,
    meanLumaApprox: meanLuma,
    elapsedMs: Math.round(now() - started),
  });

  const fail = (
    reason: FaceScanReason,
    message?: string,
    code?: BiometricErrorCode,
  ): FaceScanOutcome => {
    setState(FACE_SCAN_STATE.FAILED);
    const d = diagnostics(reason);
    faceCaptureDiag({
      stage: "scan_failed",
      reason,
      state: d.finalState,
      counters: d.counters,
      imageWidth: d.videoWidth,
      imageHeight: d.videoHeight,
      canvasWidth: d.detectorInputWidth,
      canvasHeight: d.detectorInputHeight,
      orientation: d.orientation,
      mirrored: false,
      ms: d.elapsedMs,
      errorMessage: message,
    });
    return {
      ok: false,
      reason,
      code: code ?? faceScanReasonToErrorCode(reason),
      message: message ?? faceScanReasonMessage(reason),
      diagnostics: d,
    };
  };

  const complete = (payload: AIVectorPayload): FaceScanOutcome => {
    setState(FACE_SCAN_STATE.COMPLETE);
    const d = diagnostics();
    faceCaptureDiag({
      stage: "scan_complete",
      state: d.finalState,
      counters: d.counters,
      imageWidth: d.videoWidth,
      imageHeight: d.videoHeight,
      canvasWidth: d.detectorInputWidth,
      canvasHeight: d.detectorInputHeight,
      orientation: d.orientation,
      mirrored: false,
      ms: d.elapsedMs,
    });
    return { ok: true, payload, diagnostics: d };
  };

  setState(FACE_SCAN_STATE.WAITING_FOR_FRAME);

  for (;;) {
    if (options.signal?.aborted) {
      if (best) return complete(best);
      const evidence = dominantFaceScanReason(counters, rejections);
      const outcome = fail(FACE_SCAN_REASON.SCAN_ABORTED);
      if (!outcome.ok) outcome.diagnostics.reason = evidence ?? FACE_SCAN_REASON.SCAN_ABORTED;
      return outcome;
    }
    if (now() - started >= options.budgetMs) break;

    const wait = lastSubmitAt + minInterval - now();
    if (wait > 0) await sleep(wait);

    if (state !== FACE_SCAN_STATE.WAITING_FOR_FRAME) setState(FACE_SCAN_STATE.WAITING_FOR_FRAME);
    const frame = await deps.nextFrame();
    if (options.signal?.aborted) {
      if (frame) frame.imageData.data.fill(0);
      continue;
    }
    if (!frame) {
      counters.staleFrames += 1;
      continue;
    }
    if (lastFrameId != null && frame.frameId === lastFrameId) {
      counters.staleFrames += 1;
      frame.imageData.data.fill(0);
      continue;
    }
    lastFrameId = frame.frameId;
    counters.framesObserved += 1;

    const img = frame.imageData;
    try {
      frameDims = { width: img.width, height: img.height };
      if (img.width <= 0 || img.height <= 0) {
        counters.blankFrames += 1;
        continue;
      }
      const signal = summarizeImageDataSignal(img);
      meanLuma = signal.meanLumaApprox;
      if (!signal.hasNonZeroPixels) {
        counters.blankFrames += 1;
        continue;
      }
      if (signal.meanLumaApprox < DARK_FRAME_MEAN_LUMA) {
        counters.darkFrames += 1;
        continue;
      }
      setState(FACE_SCAN_STATE.FRAME_READY);

      setState(FACE_SCAN_STATE.DETECTING);
      counters.framesSubmitted += 1;
      lastSubmitAt = now();
      let detection: DetectionResult;
      try {
        detection = await deps.detect(img);
      } catch (err) {
        counters.detectorErrors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (MODEL_UNAVAILABLE.test(msg)) {
          return fail(
            FACE_SCAN_REASON.DETECTOR_ERROR,
            msg,
            BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
          );
        }
        if (counters.detectorErrors === 1) {
          faceCaptureDiag({
            stage: "detector_error",
            errorCode: BIOMETRIC_ERROR_CODES.DETECTOR_ERROR,
            errorMessage: msg,
            imageWidth: img.width,
            imageHeight: img.height,
          });
        }
        continue;
      }
      counters.detectorSuccesses += 1;
      if (detection.input) {
        detectorInput = { width: detection.input.width, height: detection.input.height };
      }
      deps.onDetection?.(detection);
      if (detection.faces.length > 0) counters.facesDetected += 1;
      if (detection.faces.length > 1) counters.multipleFaces += 1;
      if (detection.faces.length === 0) continue;

      setState(FACE_SCAN_STATE.FACE_DETECTED);
      const candidate = deps.evaluate(img, detection);
      if (!candidate.ok) {
        const reason = candidate.reason ?? FACE_SCAN_REASON.NO_FACE_DETECTED;
        rejections[reason] = (rejections[reason] ?? 0) + 1;
        if (QUALITY_REASONS.includes(reason)) counters.qualityRejected += 1;
        continue;
      }
      counters.qualityAccepted += 1;
      setState(FACE_SCAN_STATE.QUALITY_ACCEPTED);

      setState(FACE_SCAN_STATE.EMBEDDING);
      counters.embeddingAttempts += 1;
      let embedded: BiometricExtractResult;
      try {
        embedded = await deps.embed(img, candidate);
      } catch (err) {
        counters.embeddingFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (MODEL_UNAVAILABLE.test(msg)) {
          return fail(
            FACE_SCAN_REASON.EMBEDDING_FAILED,
            msg,
            BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
          );
        }
        continue;
      }
      if (!embedded.ok) {
        if (embedded.code === BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE) {
          return fail(
            FACE_SCAN_REASON.EMBEDDING_FAILED,
            embedded.message,
            BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
          );
        }
        if (embedded.code === BIOMETRIC_ERROR_CODES.LIVENESS_FAILED) {
          return fail(FACE_SCAN_REASON.LIVENESS_NOT_CONFIRMED, embedded.message, embedded.code);
        }
        const reason = embedded.reason ?? FACE_SCAN_REASON.EMBEDDING_FAILED;
        rejections[reason] = (rejections[reason] ?? 0) + 1;
        if (reason === FACE_SCAN_REASON.EMBEDDING_FAILED) counters.embeddingFailures += 1;
        continue;
      }
      if (embedded.payload.confidence >= options.acceptConfidence) {
        return complete(embedded.payload);
      }
      if (!best || embedded.payload.confidence > best.confidence) best = embedded.payload;
    } finally {
      img.data.fill(0);
    }
  }

  if (best) return complete(best);
  const evidence = dominantFaceScanReason(counters, rejections);
  return fail(evidence ?? FACE_SCAN_REASON.SCAN_TIMEOUT);
}
