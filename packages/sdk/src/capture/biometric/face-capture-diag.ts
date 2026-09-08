/**
 * Safe face-capture diagnostics — metadata only.
 * Enable with: localStorage.TRUSTID_FACE_CAPTURE_DIAG = "1"
 * or window.__TRUSTID_FACE_CAPTURE_DIAG__ = true
 * Never logs frames, ImageData, vectors, embeddings, or landmarks.
 */

export type FaceCaptureDiagEvent = {
  scope: "face_capture_diag";
  stage: string;
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
  runningMode?: string;
  squarePadded?: boolean;
  modelReady?: boolean;
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

export function faceCaptureDiag(event: Omit<FaceCaptureDiagEvent, "scope">): void {
  if (!isFaceCaptureDiagEnabled()) return;
  // Explicit allow-list — never spread unknown fields that might hold biometrics.
  const safe: FaceCaptureDiagEvent = {
    scope: "face_capture_diag",
    stage: event.stage,
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
    runningMode: event.runningMode,
    squarePadded: event.squarePadded,
    modelReady: event.modelReady,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage
      ? String(event.errorMessage).slice(0, 200)
      : undefined,
  };
  console.info("[TrustID]", JSON.stringify(safe));
}
