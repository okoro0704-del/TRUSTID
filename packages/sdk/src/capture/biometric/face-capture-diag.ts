/**
 * Safe face-capture / model-init diagnostics — metadata only.
 * Enable: localStorage.TRUSTID_FACE_CAPTURE_DIAG = "1"
 * Never logs frames, ImageData, vectors, embeddings, landmarks, or model bytes.
 */

export type FaceCaptureDiagEvent = {
  scope: "face_capture_diag";
  stage: string;
  component?: string;
  success?: boolean;
  ms?: number;
  videoWidth?: number;
  videoHeight?: number;
  imageWidth?: number;
  imageHeight?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  hasNonZeroPixels?: boolean;
  sampledNonZeroRatio?: number;
  meanLumaApprox?: number;
  faceLandmarksCount?: number;
  faceBlendshapesCount?: number;
  delegate?: string;
  executionProvider?: string;
  runningMode?: string;
  squarePadded?: boolean;
  modelReady?: boolean;
  modelUrl?: string;
  expectedHashPrefix?: string;
  actualHashPrefix?: string;
  errorCode?: string;
  errorMessage?: string;
};

export function isFaceCaptureDiagEnabled(): boolean {
  if (typeof window === "undefined") {
    return process.env.TRUSTID_FACE_CAPTURE_DIAG === "1";
  }
  try {
    const w = window as Window & {
      __TRUSTID_FACE_CAPTURE_DIAG__?: boolean;
    };
    if (w.__TRUSTID_FACE_CAPTURE_DIAG__ === true) return true;
    return window.localStorage?.getItem("TRUSTID_FACE_CAPTURE_DIAG") === "1";
  } catch {
    return false;
  }
}

/** Sample pixel energy without retaining or logging raw samples. */
export function summarizeImageDataSignal(imageData: ImageData): {
  hasNonZeroPixels: boolean;
  sampledNonZeroRatio: number;
  meanLumaApprox: number;
} {
  const { data, width, height } = imageData;
  const pixels = width * height;
  if (pixels <= 0) {
    return {
      hasNonZeroPixels: false,
      sampledNonZeroRatio: 0,
      meanLumaApprox: 0,
    };
  }
  const step = Math.max(1, Math.floor(pixels / 256));
  let samples = 0;
  let nonZero = 0;
  let lumaSum = 0;
  for (let i = 0; i < pixels; i += step) {
    const o = i * 4;
    const r = data[o] ?? 0;
    const g = data[o + 1] ?? 0;
    const b = data[o + 2] ?? 0;
    samples++;
    if (r | g | b) nonZero++;
    lumaSum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return {
    hasNonZeroPixels: nonZero > 0,
    sampledNonZeroRatio: samples ? nonZero / samples : 0,
    meanLumaApprox: samples ? Math.round(lumaSum / samples) : 0,
  };
}

export function hashPrefix(hex: string, n = 12): string {
  return hex.slice(0, n).toLowerCase();
}

export function sanitizeInitError(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof Event !== "undefined" && err instanceof Event) {
    raw = `Event:${err.type}`;
  } else {
    raw = String(err);
  }
  if (raw === "[object Event]") raw = "Event:unknown";
  return raw
    .replace(/[0-9a-f]{64}/gi, (h) => `${h.slice(0, 12)}…`)
    .slice(0, 240);
}

export function faceCaptureDiag(
  event: Omit<FaceCaptureDiagEvent, "scope">,
): void {
  if (!isFaceCaptureDiagEnabled()) return;
  const safe: FaceCaptureDiagEvent = {
    scope: "face_capture_diag",
    stage: event.stage,
    component: event.component,
    success: event.success,
    ms: event.ms,
    videoWidth: event.videoWidth,
    videoHeight: event.videoHeight,
    imageWidth: event.imageWidth,
    imageHeight: event.imageHeight,
    canvasWidth: event.canvasWidth,
    canvasHeight: event.canvasHeight,
    hasNonZeroPixels: event.hasNonZeroPixels,
    sampledNonZeroRatio: event.sampledNonZeroRatio,
    meanLumaApprox: event.meanLumaApprox,
    faceLandmarksCount: event.faceLandmarksCount,
    faceBlendshapesCount: event.faceBlendshapesCount,
    delegate: event.delegate,
    executionProvider: event.executionProvider,
    runningMode: event.runningMode,
    squarePadded: event.squarePadded,
    modelReady: event.modelReady,
    modelUrl: event.modelUrl,
    expectedHashPrefix: event.expectedHashPrefix,
    actualHashPrefix: event.actualHashPrefix,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage
      ? sanitizeInitError(event.errorMessage)
      : undefined,
  };
  console.info("[TrustID]", JSON.stringify(safe));
}
