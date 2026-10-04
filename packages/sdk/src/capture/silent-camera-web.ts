/**
 * Silent web capture with production ArcFace pipeline + multi-frame blink PAD.
 *
 * Readiness is proven step by step (camera granted → live track → video
 * metadata with real dimensions → a presented frame) before any inference.
 * Inference frames are drawn with an identity transform: never mirrored,
 * never cropped. There is no preview here, so presentation transforms cannot
 * leak into detector input.
 */
import {
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
  BIOMETRIC_MODALITIES,
  FACE_SCAN_REASON,
  type FaceScanDiagnostics,
  type FaceScanReason,
} from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { getSharedAIVectorExtractor } from "./ai-vector-extractor.js";
import { MediaPipeBlinkPadDetector } from "./biometric/pad-blink.js";
import {
  embedFaceCandidate,
  evaluateFaceCandidate,
} from "./biometric/pipeline.js";
import {
  detectFacesInImageData,
  getFaceDetectorStatus,
} from "./biometric/detector-mediapipe.js";
import { getArcFaceEmbedderState } from "./biometric/recognizer-arcface.js";
import { faceCaptureDiag } from "./biometric/face-capture-diag.js";
import {
  emptyFaceScanCounters,
  FACE_SCAN_STATE,
  faceScanReasonMessage,
  faceScanReasonToErrorCode,
  runFaceScanLoop,
  type FaceScanState,
  type ScanFrame,
} from "./biometric/face-scan-loop.js";

export type SilentWebCaptureResult = {
  payload: BiometricPayload;
  confidence: number;
  errorCode?: string;
  errorMessage?: string;
  /** Precise reason when no usable face was produced (diagnostic). */
  reasonCode?: FaceScanReason;
  /** Non-biometric scan summary. */
  diagnostics?: FaceScanDiagnostics;
};

export type MediaStreamFactory = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

export type FaceCaptureOptions = {
  signal?: AbortSignal;
  /** Sampling window once the first frame exists and models are ready. */
  scanBudgetMs?: number;
  onState?: (state: FaceScanState) => void;
};

export const DEFAULT_FACE_SCAN_BUDGET_MS = 20_000;
const VIDEO_READY_TIMEOUT_MS = 8_000;
const FIRST_FRAME_TIMEOUT_MS = 8_000;
/** How long to wait for one presented frame before falling back to polling. */
const FRAME_CALLBACK_WAIT_MS = 700;
const FRAME_POLL_MS = 100;
/** Detector cadence: at most ~8 submissions per second on mobile CPUs. */
const SCAN_MIN_INTERVAL_MS = 120;
const CAMERA_RELEASE_WAIT_MS = 3_000;
const MODEL_BASE_URL = "/models/trustid";

/**
 * resizeMode "none" keeps the native (rotated) camera format. With the default
 * crop-and-scale, Chrome crops a 480×640 portrait stream to 480×480 to honour
 * a landscape 640×480 request.
 */
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "user",
    width: { ideal: 640 },
    height: { ideal: 480 },
    resizeMode: "none",
  } as MediaTrackConstraints,
  audio: false,
};

class FaceScanError extends Error {
  constructor(
    readonly reason: FaceScanReason,
    message: string,
  ) {
    super(message);
    this.name = "FaceScanError";
  }
}

function emptyPayload(): BiometricPayload {
  return {
    modality: BIOMETRIC_MODALITIES.FACE,
    vector: [],
    modelName: "none",
    modelVersion: 0,
    confidence: 0,
  };
}

function failure(
  reason: FaceScanReason,
  message?: string,
  errorCode?: string,
  diagnostics?: FaceScanDiagnostics,
): SilentWebCaptureResult {
  return {
    confidence: 0,
    payload: emptyPayload(),
    errorCode: errorCode ?? faceScanReasonToErrorCode(reason),
    errorMessage: message ?? faceScanReasonMessage(reason),
    reasonCode: reason,
    diagnostics,
  };
}

function baseDiagnostics(finalState: string, reason?: FaceScanReason): FaceScanDiagnostics {
  return {
    reason,
    finalState,
    counters: emptyFaceScanCounters(),
    inferenceMirrored: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError(): FaceScanError {
  return new FaceScanError(FACE_SCAN_REASON.SCAN_ABORTED, "Capture aborted");
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function createHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.setAttribute("muted", "true");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  // Keep the element renderable. display:none / 0×0 often freezes frame decode
  // in Chromium, producing blank ImageData and MediaPipe NO_FACE.
  video.style.cssText =
    "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1";
  document.body.appendChild(video);
  return video;
}

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  });
}

function liveVideoTrack(stream: MediaStream): MediaStreamTrack | null | undefined {
  // Test doubles may expose only getTracks(); undefined means "cannot check".
  if (typeof stream.getVideoTracks !== "function") return undefined;
  return stream.getVideoTracks().find((t) => t.readyState === "live") ?? null;
}

/** One camera owner at a time: a new scan stops the previous one first. */
let activeCamera: { abort: () => void; released: Promise<void> } | null = null;

async function acquireCamera(controller: AbortController): Promise<() => void> {
  const previous = activeCamera;
  if (previous) {
    previous.abort();
    await Promise.race([previous.released, delay(CAMERA_RELEASE_WAIT_MS)]);
  }
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const slot = { abort: () => controller.abort(), released };
  activeCamera = slot;
  return () => {
    if (activeCamera === slot) activeCamera = null;
    release();
  };
}

function waitForVideoReady(
  video: HTMLVideoElement,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = ["loadedmetadata", "loadeddata", "resize", "playing"] as const;
    const cleanup = () => {
      window.clearTimeout(timer);
      events.forEach((e) => video.removeEventListener(e, check));
      signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      if (
        video.readyState >= HTMLMediaElement.HAVE_METADATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new FaceScanError(
          FACE_SCAN_REASON.NO_VIDEO_FRAME,
          `Camera granted but video metadata never arrived (readyState=${video.readyState}, ${video.videoWidth}x${video.videoHeight})`,
        ),
      );
    }, timeoutMs);
    events.forEach((e) => video.addEventListener(e, check));
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

type VideoFrameMeta = { presentedFrames?: number; mediaTime?: number };
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, meta: VideoFrameMeta) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type VideoFrameSource = {
  readonly kind: () => FaceScanDiagnostics["frameSource"];
  /** Resolve true once a real frame is available on the element. */
  waitForPresentedFrame: (timeoutMs: number) => Promise<boolean>;
  nextFrame: () => Promise<ScanFrame | null>;
  dispose: () => void;
};

/**
 * Fresh frames from a playing video element. Uses requestVideoFrameCallback
 * where it fires; falls back to readyState polling with currentTime staleness
 * checks (hidden videos may never be composited, so rVFC can stay silent).
 */
export function createVideoFrameSource(video: HTMLVideoElement): VideoFrameSource {
  const v = video as VideoWithFrameCallback;
  let mode: NonNullable<FaceScanDiagnostics["frameSource"]> =
    typeof v.requestVideoFrameCallback === "function" ? "video-frame-callback" : "video-poll";
  let callbackMisses = 0;
  let pending: number | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;

  const waitCallback = (timeoutMs: number): Promise<VideoFrameMeta | null> =>
    new Promise((resolve) => {
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        if (pending != null) v.cancelVideoFrameCallback?.(pending);
        pending = null;
        resolve(null);
      }, timeoutMs);
      pending = v.requestVideoFrameCallback!((_now, meta) => {
        if (done) return;
        done = true;
        pending = null;
        window.clearTimeout(timer);
        resolve(meta ?? {});
      });
    });

  const hasFrameData = () =>
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0;

  const grab = (frameId: number): ScanFrame | null => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w <= 0 || h <= 0) return null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return null;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(video, 0, 0, w, h);
    return { imageData: ctx.getImageData(0, 0, w, h), frameId };
  };

  let pollSeq = 0;
  return {
    kind: () => mode,
    async waitForPresentedFrame(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (mode === "video-frame-callback") {
          const meta = await waitCallback(Math.min(FRAME_CALLBACK_WAIT_MS, deadline - Date.now()));
          if (meta && hasFrameData()) return true;
          if (!meta && ++callbackMisses >= 3) mode = "video-poll";
          continue;
        }
        if (hasFrameData()) return true;
        await delay(FRAME_POLL_MS);
      }
      return false;
    },
    async nextFrame() {
      if (mode === "video-frame-callback") {
        const meta = await waitCallback(FRAME_CALLBACK_WAIT_MS);
        if (!meta) {
          if (++callbackMisses >= 3) mode = "video-poll";
          return null;
        }
        callbackMisses = 0;
        if (!hasFrameData()) return null;
        return grab(meta.presentedFrames ?? ++pollSeq);
      }
      await delay(FRAME_POLL_MS);
      if (!hasFrameData()) return null;
      // A live stream's currentTime advances with each frame; an unchanged
      // value means this would be a stale frame. Some engines keep it at 0.
      const t = video.currentTime;
      return grab(t > 0 ? -Math.round(t * 1000) - 1 : -1_000_000_000 - ++pollSeq);
    },
    dispose() {
      if (pending != null) v.cancelVideoFrameCallback?.(pending);
      pending = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      canvas = null;
      ctx = null;
    },
  };
}

type OpenCamera = {
  stream: MediaStream;
  video: HTMLVideoElement;
  frames: VideoFrameSource;
};

async function openCamera(
  streamFactory: MediaStreamFactory,
  signal: AbortSignal,
  setState: (s: FaceScanState) => void,
  holder: { stream?: MediaStream; video?: HTMLVideoElement },
): Promise<OpenCamera> {
  setState(FACE_SCAN_STATE.REQUESTING_CAMERA);
  let stream: MediaStream;
  const pendingStream = Promise.resolve().then(() => streamFactory(CAMERA_CONSTRAINTS));
  try {
    stream = await raceAbort(pendingStream, signal);
  } catch (err) {
    if (err instanceof FaceScanError) {
      // A stream granted after cancellation must still be released.
      pendingStream.then(stopStream, () => undefined);
      throw err;
    }
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new FaceScanError(FACE_SCAN_REASON.CAMERA_UNAVAILABLE, msg);
  }
  holder.stream = stream;
  if (signal.aborted) throw abortError();
  setState(FACE_SCAN_STATE.CAMERA_GRANTED);

  const track = liveVideoTrack(stream);
  if (track === null) {
    throw new FaceScanError(
      FACE_SCAN_REASON.CAMERA_UNAVAILABLE,
      "Camera granted but the stream has no live video track",
    );
  }

  setState(FACE_SCAN_STATE.WAITING_FOR_VIDEO);
  const video = createHiddenVideo();
  holder.video = video;
  video.srcObject = stream;
  try {
    await raceAbort(Promise.resolve(video.play()), signal);
  } catch (err) {
    if (err instanceof FaceScanError) throw err;
    // Autoplay rejections still leave a muted inline stream playing in most
    // engines; readiness below decides.
    faceCaptureDiag({
      stage: "video_play_rejected",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
  await waitForVideoReady(video, signal, VIDEO_READY_TIMEOUT_MS);
  setState(FACE_SCAN_STATE.VIDEO_READY);
  faceCaptureDiag({
    stage: "camera_ready",
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
    trackState: track?.readyState,
    orientation:
      video.videoHeight > video.videoWidth
        ? "portrait"
        : video.videoHeight < video.videoWidth
          ? "landscape"
          : "square",
    mirrored: false,
  });

  setState(FACE_SCAN_STATE.WAITING_FOR_FRAME);
  const frames = createVideoFrameSource(video);
  const presented = await raceAbort(frames.waitForPresentedFrame(FIRST_FRAME_TIMEOUT_MS), signal);
  if (!presented) {
    frames.dispose();
    throw new FaceScanError(
      FACE_SCAN_REASON.NO_VIDEO_FRAME,
      `Video ready (${video.videoWidth}x${video.videoHeight}) but no frame was presented`,
    );
  }
  setState(FACE_SCAN_STATE.FRAME_READY);
  faceCaptureDiag({ stage: "first_frame_ready", frameSource: frames.kind(), readyState: video.readyState });
  return { stream, video, frames };
}

function linkAbort(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

function resolveStreamFactory(getStream?: MediaStreamFactory): MediaStreamFactory | null {
  if (getStream) return getStream;
  if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
    return (c) => navigator.mediaDevices.getUserMedia(c);
  }
  return null;
}

function closeCamera(holder: { stream?: MediaStream; video?: HTMLVideoElement }) {
  stopStream(holder.stream);
  if (holder.video) {
    holder.video.srcObject = null;
    holder.video.remove();
  }
}

/**
 * Off-screen face scan: ArcFace embed of the best quality-accepted frame.
 * Never uses spatial_fallback. Never logs embeddings or frames.
 */
export async function captureSilentFaceFromWebCamera(
  getStream?: MediaStreamFactory,
  options?: FaceCaptureOptions,
): Promise<SilentWebCaptureResult | null> {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  if (options?.signal?.aborted) {
    return failure(FACE_SCAN_REASON.SCAN_ABORTED, "Capture aborted", BIOMETRIC_ERROR_CODES.NO_FACE);
  }
  const streamFactory = resolveStreamFactory(getStream);
  if (!streamFactory) return null;

  const controller = new AbortController();
  const unlink = linkAbort(options?.signal, controller);
  const signal = controller.signal;
  const holder: { stream?: MediaStream; video?: HTMLVideoElement } = {};
  const stopOnAbort = () => stopStream(holder.stream);
  signal.addEventListener("abort", stopOnAbort, { once: true });

  let state: FaceScanState = FACE_SCAN_STATE.IDLE;
  const setState = (s: FaceScanState) => {
    state = s;
    options?.onState?.(s);
    faceCaptureDiag({ stage: "scan_state", state: s });
  };

  const pad = new MediaPipeBlinkPadDetector();
  // Models warm up while the camera starts; neither waits on the other.
  const modelsReady = getSharedAIVectorExtractor({ modelBaseUrl: MODEL_BASE_URL, pad }).catch(
    () => null,
  );
  let frames: VideoFrameSource | null = null;
  let releaseCamera: (() => void) | null = null;

  try {
    releaseCamera = await acquireCamera(controller);
    const camera = await openCamera(streamFactory, signal, setState, holder);
    frames = camera.frames;

    setState(FACE_SCAN_STATE.PREPARING_MODELS);
    const extractor = await raceAbort(modelsReady, signal).catch((err) => {
      if (err instanceof FaceScanError && err.reason === FACE_SCAN_REASON.SCAN_ABORTED) {
        const d = baseDiagnostics(state, FACE_SCAN_REASON.MODELS_NOT_READY);
        throw Object.assign(err, { diagnostics: d });
      }
      return null;
    });
    const detectorReady = getFaceDetectorStatus().state === "READY";
    const embedderReady = getArcFaceEmbedderState() === "READY";
    faceCaptureDiag({
      stage: "extractor_ready_check",
      modelReady: Boolean(extractor?.isReady()),
      errorMessage: `detector=${detectorReady ? "ready" : "not-ready"} embedder=${embedderReady ? "ready" : "not-ready"}`,
    });
    if (!extractor?.isReady()) {
      return failure(
        FACE_SCAN_REASON.MODELS_NOT_READY,
        extractor?.getLastError() ??
          "Face biometric models unavailable. Install /models/trustid artifacts.",
        BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
        { ...baseDiagnostics(state, FACE_SCAN_REASON.MODELS_NOT_READY), detectorReady, embedderReady },
      );
    }

    const outcome = await runFaceScanLoop(
      {
        nextFrame: () => camera.frames.nextFrame(),
        detect: (img) => detectFacesInImageData(img, MODEL_BASE_URL),
        evaluate: (img, detection) =>
          evaluateFaceCandidate(img, detection, { rejectMultipleFaces: true }),
        embed: (img, candidate) =>
          embedFaceCandidate(img, candidate, { modelBaseUrl: MODEL_BASE_URL, skipPad: true }),
        onDetection: (detection) => pad.observeBlendshapes(detection.blendshapes?.[0]),
        onState: setState,
      },
      {
        signal,
        budgetMs: options?.scanBudgetMs ?? DEFAULT_FACE_SCAN_BUDGET_MS,
        minIntervalMs: SCAN_MIN_INTERVAL_MS,
        acceptConfidence: BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE,
      },
    );
    const diagnostics: FaceScanDiagnostics = {
      ...outcome.diagnostics,
      frameSource: camera.frames.kind(),
      detectorReady,
      embedderReady,
    };

    if (outcome.ok) {
      return {
        confidence: outcome.payload.confidence,
        payload: {
          modality: BIOMETRIC_MODALITIES.FACE,
          vector: outcome.payload.vector,
          modelName: outcome.payload.modelName,
          modelVersion: outcome.payload.modelVersion,
          confidence: outcome.payload.confidence,
        },
        diagnostics,
      };
    }
    return failure(outcome.reason, outcome.message, outcome.code, diagnostics);
  } catch (err) {
    if (err instanceof FaceScanError) {
      const d =
        (err as FaceScanError & { diagnostics?: FaceScanDiagnostics }).diagnostics ??
        baseDiagnostics(state, err.reason);
      faceCaptureDiag({ stage: "scan_failed", reason: err.reason, state, errorMessage: err.message });
      return failure(
        err.reason,
        err.message,
        err.reason === FACE_SCAN_REASON.SCAN_ABORTED ? BIOMETRIC_ERROR_CODES.NO_FACE : undefined,
        d,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    faceCaptureDiag({ stage: "scan_failed", state, errorMessage: msg });
    if (/unavailable|integrity|onnx|mediapipe|model/i.test(msg)) {
      return failure(
        FACE_SCAN_REASON.MODELS_NOT_READY,
        msg,
        BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
        baseDiagnostics(state, FACE_SCAN_REASON.MODELS_NOT_READY),
      );
    }
    return failure(
      FACE_SCAN_REASON.EMBEDDING_FAILED,
      msg,
      BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      baseDiagnostics(state, FACE_SCAN_REASON.EMBEDDING_FAILED),
    );
  } finally {
    signal.removeEventListener("abort", stopOnAbort);
    unlink();
    frames?.dispose();
    closeCamera(holder);
    pad.reset();
    releaseCamera?.();
  }
}

export function isSilentWebCameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * Enrollment capture: active blink liveness, then multi-frame quality-filtered
 * aggregation via enrollFromImageFrames (mean / quality-weighted primary).
 * Auth path remains captureSilentFaceFromWebCamera (single accepted frame).
 */
export async function captureSilentFaceEnrollmentFromWebCamera(
  getStream?: MediaStreamFactory,
  options: { minAccepted?: number; maxFrames?: number; signal?: AbortSignal } = {},
): Promise<SilentWebCaptureResult | null> {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  const streamFactory = resolveStreamFactory(getStream);
  if (!streamFactory) return null;

  const { enrollFromImageFrames } = await import("./biometric/enrollment.js");
  const controller = new AbortController();
  const unlink = linkAbort(options.signal, controller);
  const signal = controller.signal;
  const holder: { stream?: MediaStream; video?: HTMLVideoElement } = {};
  const pad = new MediaPipeBlinkPadDetector();
  const frames: ImageData[] = [];
  const minAccepted = options.minAccepted ?? 3;
  const maxFrames = options.maxFrames ?? 12;
  let source: VideoFrameSource | null = null;
  let releaseCamera: (() => void) | null = null;
  let state: FaceScanState = FACE_SCAN_STATE.IDLE;

  try {
    const modelsReady = getSharedAIVectorExtractor({ modelBaseUrl: MODEL_BASE_URL, pad }).catch(
      () => null,
    );
    releaseCamera = await acquireCamera(controller);
    const camera = await openCamera(
      streamFactory,
      signal,
      (s) => {
        state = s;
      },
      holder,
    );
    source = camera.frames;

    const extractor = await raceAbort(modelsReady, signal);
    if (!extractor?.isReady()) {
      return failure(
        FACE_SCAN_REASON.MODELS_NOT_READY,
        extractor?.getLastError() ??
          "Face biometric models unavailable. Install /models/trustid artifacts.",
        BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE,
      );
    }

    let blinkOk = false;
    let detectorSuccesses = 0;
    let lastDetectorError = "";
    for (let i = 0; i < 48 && !signal.aborted; i++) {
      const frame = await camera.frames.nextFrame();
      if (!frame) continue;
      try {
        const det = await detectFacesInImageData(frame.imageData, MODEL_BASE_URL);
        detectorSuccesses += 1;
        pad.observeBlendshapes(det.blendshapes?.[0]);
        const padCheck = await pad.evaluate();
        if (padCheck.decision === "accept") {
          blinkOk = true;
          frames.push(frame.imageData);
          break;
        }
      } catch (err) {
        lastDetectorError = err instanceof Error ? err.message : String(err);
      }
      frame.imageData.data.fill(0);
    }

    if (!blinkOk && detectorSuccesses === 0 && lastDetectorError) {
      return failure(FACE_SCAN_REASON.DETECTOR_ERROR, lastDetectorError);
    }
    if (!blinkOk) {
      return failure(
        FACE_SCAN_REASON.LIVENESS_NOT_CONFIRMED,
        "Blink to confirm liveness, then try again",
        BIOMETRIC_ERROR_CODES.LIVENESS_FAILED,
      );
    }

    for (let i = 0; i < maxFrames * 3 && frames.length < maxFrames && !signal.aborted; i++) {
      await delay(150);
      const frame = await camera.frames.nextFrame();
      if (frame) frames.push(frame.imageData);
    }

    const enrolled = await enrollFromImageFrames(frames, {
      modelBaseUrl: MODEL_BASE_URL,
      skipPad: true,
      rejectMultipleFaces: true,
      minAccepted,
      qualityWeighted: true,
    });

    if (!enrolled.primary) {
      const reasons = enrolled.rejected.map((r) => r.reason).filter(Boolean);
      return failure(
        reasons[reasons.length - 1] ?? FACE_SCAN_REASON.NO_FACE_DETECTED,
        enrolled.rejected.map((r) => r.message).join("; ") ||
          "Enrollment needs more high-quality frames",
        BIOMETRIC_ERROR_CODES.LOW_QUALITY,
      );
    }

    return {
      confidence: enrolled.primary.confidence,
      payload: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector: enrolled.primary.vector,
        modelName: enrolled.primary.modelName,
        modelVersion: enrolled.primary.modelVersion,
        confidence: enrolled.primary.confidence,
      },
    };
  } catch (err) {
    if (err instanceof FaceScanError) {
      return failure(err.reason, err.message, undefined, baseDiagnostics(state, err.reason));
    }
    const msg = err instanceof Error ? err.message : String(err);
    return failure(
      FACE_SCAN_REASON.EMBEDDING_FAILED,
      msg || "Enrollment capture failed",
      /unavailable|integrity|onnx|mediapipe|model/i.test(msg)
        ? BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_UNAVAILABLE
        : BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
    );
  } finally {
    for (const f of frames) {
      try {
        f.data.fill(0);
      } catch {
        /* ignore */
      }
    }
    unlink();
    source?.dispose();
    closeCamera(holder);
    pad.reset();
    releaseCamera?.();
  }
}
