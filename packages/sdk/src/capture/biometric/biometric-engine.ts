/**
 * One biometric engine contract for every platform.
 *
 * Application code talks to `BiometricEngine` and never to a runtime. Today
 * every platform runs the same engine (MediaPipe detector + ArcFace on ORT
 * WASM); what differs is where its pinned bytes come from:
 *
 *   web      Cache Storage, else resumable network download
 *   android  the installed app (no model download), else network
 *   ios      the installed app (no model download), else network
 *
 * Because the bytes and the code are identical, web, Android and iOS produce
 * embeddings in one space by construction. A future native inference
 * implementation must implement this same interface and reproduce the
 * engine conformance vector (engine-conformance.ts) before it may be used.
 *
 * Status separates three facts that must never be conflated:
 *   BIOMETRIC_ENGINE_READY      local inference can run (works offline)
 *   IDENTITY_NETWORK_AVAILABLE  the device can reach TrustID
 *   IDENTIFICATION_AVAILABLE    both: a scan can be matched to an identity
 * An engine or network failure is reported as such, never as NO_MATCH.
 */
import {
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
} from "@trustid/shared";
import { getAssetProgress, type BiometricAssetId, type BiometricAssetSource } from "./asset-progress.js";
import { getNativeBiometricBundle, loadBiometricAsset } from "./asset-delivery.js";
import {
  ensureBiometricReady,
  getBiometricReadiness,
  subscribeBiometricReadiness,
  type BiometricComponent,
  type BiometricFailureCategory,
  type BiometricReadinessSnapshot,
} from "./biometric-readiness.js";
import { detectFacesInImageData, type DetectionResult } from "./detector-mediapipe.js";
import {
  BIOMETRIC_ENGINE_RELEASE,
  BIOMETRIC_RELEASE_ASSETS,
  biometricAssetDir,
  type BiometricReleaseAssetId,
} from "./model-manifest.js";
import {
  embedFaceCandidate,
  evaluateFaceCandidate,
  type FaceCandidate,
  type FacePipelineOptions,
} from "./pipeline.js";
import type { BiometricExtractError, BiometricExtractResult } from "./types.js";

export const BIOMETRIC_ENGINE_STATE = {
  IDLE: "IDLE",
  PREPARING: "PREPARING",
  DOWNLOADING: "DOWNLOADING",
  VERIFYING: "VERIFYING",
  INITIALIZING: "INITIALIZING",
  WARMING_UP: "WARMING_UP",
  READY: "READY",
  FAILED: "FAILED",
} as const;

export type BiometricEngineState = (typeof BIOMETRIC_ENGINE_STATE)[keyof typeof BIOMETRIC_ENGINE_STATE];

export type BiometricPlatform = "web" | "android" | "ios";

export type BiometricEngineStatus = {
  state: BiometricEngineState;
  platform: BiometricPlatform;
  /** Where inference runs. Identical on every platform today. */
  inference: "wasm";
  releaseId: string;
  embedder: { modelName: string; modelVersion: number; sha256: string; dimensions: number };
  detectorVersion: string;
  alignmentVersion: string;
  preprocessingVersion: string;
  /** Where this run's assets came from; "mixed" when sources differ. */
  assetSource: BiometricAssetSource | "mixed" | null;
  /** Network transfer only (compressed bytes). Null when nothing is downloading. */
  download: { loaded: number; total: number | null } | null;
  BIOMETRIC_ENGINE_READY: boolean;
  IDENTITY_NETWORK_AVAILABLE: boolean;
  IDENTIFICATION_AVAILABLE: boolean;
  failure: {
    component: BiometricComponent;
    category: BiometricFailureCategory | null;
    requiresReload: boolean;
  } | null;
  timingsMs: Partial<Record<BiometricComponent, number>>;
};

export type BiometricCameraSession = {
  video: HTMLVideoElement;
  stream: MediaStream;
};

/** The single contract every platform implementation satisfies. */
export interface BiometricEngine {
  readonly platform: BiometricPlatform;
  readonly release: typeof BIOMETRIC_ENGINE_RELEASE;
  initialize(): Promise<BiometricEngineStatus>;
  getStatus(): BiometricEngineStatus;
  subscribe(listener: (status: BiometricEngineStatus) => void): () => void;
  openCamera(constraints?: MediaTrackConstraints): Promise<BiometricCameraSession>;
  detectFace(frame: ImageData): Promise<DetectionResult>;
  evaluateQuality(
    frame: ImageData,
    detection: DetectionResult,
    options?: Pick<FacePipelineOptions, "rejectMultipleFaces">,
  ): FaceCandidate | BiometricExtractError;
  createEmbedding(
    frame: ImageData,
    candidate: FaceCandidate,
    options?: FacePipelineOptions,
  ): Promise<BiometricExtractResult>;
  closeCamera(): void;
  dispose(): void;
}

const ASSET_IDS: BiometricAssetId[] = [
  "ort-wasm",
  "ort-loader",
  "mediapipe-wasm",
  "mediapipe-loader",
  "face-landmarker",
  "arcface",
];

type CapacitorGlobal = { getPlatform?: () => string; isNativePlatform?: () => boolean };

export function detectBiometricPlatform(): BiometricPlatform {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.()) return "web";
  const p = cap.getPlatform?.();
  return p === "android" || p === "ios" ? p : "web";
}

function networkAvailable(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

function assetPicture(): Pick<BiometricEngineStatus, "assetSource" | "download"> & {
  downloading: boolean;
  verifying: boolean;
  allAssetsReady: boolean;
} {
  const sources = new Set<BiometricAssetSource>();
  let loaded = 0;
  let total = 0;
  let totalKnown = true;
  let downloading = false;
  let verifying = false;
  let seen = 0;
  let ready = 0;
  for (const id of ASSET_IDS) {
    const p = getAssetProgress(id);
    if (!p) continue;
    seen += 1;
    const source = p.source ?? (p.fromCache ? "cache" : "network");
    sources.add(source);
    if (p.phase === "ready" || (p.phase === undefined && p.fromCache)) ready += 1;
    if (source === "network") {
      loaded += p.loaded;
      if (p.total == null) totalKnown = false;
      else total += p.total;
      if (p.phase === "downloading") downloading = true;
    }
    if (p.phase === "decoding" || p.phase === "verifying") verifying = true;
  }
  const assetSource = sources.size === 0 ? null : sources.size === 1 ? [...sources][0]! : "mixed";
  return {
    assetSource,
    download: downloading ? { loaded, total: totalKnown ? total : null } : null,
    downloading,
    verifying,
    allAssetsReady: seen > 0 && ready === seen,
  };
}

/** Engine status derived from the readiness owner and asset progress. Pure read. */
export function biometricEngineStatusFromReadiness(
  snap: BiometricReadinessSnapshot,
  platform: BiometricPlatform = detectBiometricPlatform(),
): BiometricEngineStatus {
  const assets = assetPicture();
  // Component states, not snap.loading: the final snapshot of a pass is taken
  // while the pass is still marked in flight.
  const componentLoading = (["runtime", "detector", "embedder", "warmup"] as const).some(
    (c) => snap[c].state === "LOADING",
  );
  let state: BiometricEngineState;
  if (snap.ready) state = "READY";
  else if (snap.failed && !componentLoading) state = "FAILED";
  else if (snap.warmup.state === "LOADING") state = "WARMING_UP";
  else if (assets.downloading) state = "DOWNLOADING";
  else if (assets.verifying) state = "VERIFYING";
  else if (snap.loading && assets.allAssetsReady) state = "INITIALIZING";
  else if (snap.loading) state = "PREPARING";
  else state = "IDLE";

  const failedComponent = (["runtime", "detector", "embedder", "warmup"] as const).find(
    (c) => snap[c].state === "FAILED",
  );
  const timingsMs: Partial<Record<BiometricComponent, number>> = {};
  for (const c of ["runtime", "detector", "embedder", "warmup"] as const) {
    const ms = snap[c].durationMs;
    if (ms != null) timingsMs[c] = ms;
  }
  const engineReady = state === "READY";
  const net = networkAvailable();
  return {
    state,
    platform,
    inference: "wasm",
    releaseId: BIOMETRIC_ENGINE_RELEASE.releaseId,
    embedder: {
      modelName: BIOMETRIC_ENGINE_RELEASE.embedder.modelName,
      modelVersion: BIOMETRIC_ENGINE_RELEASE.embedder.modelVersion,
      sha256: BIOMETRIC_ENGINE_RELEASE.embedder.sha256,
      dimensions: BIOMETRIC_ENGINE_RELEASE.embedder.dimensions,
    },
    detectorVersion: BIOMETRIC_DETECTOR_VERSION,
    alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
    preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
    assetSource: assets.assetSource,
    download: assets.download,
    BIOMETRIC_ENGINE_READY: engineReady,
    IDENTITY_NETWORK_AVAILABLE: net,
    IDENTIFICATION_AVAILABLE: engineReady && net,
    failure: failedComponent
      ? {
          component: failedComponent,
          category: snap[failedComponent].failureCategory,
          requiresReload: snap.requiresReload,
        }
      : null,
    timingsMs,
  };
}

/** User-facing line for a status. Infrastructure states only; never a match result. */
export function describeBiometricEngineStatus(s: BiometricEngineStatus): string {
  switch (s.state) {
    case "IDLE":
    case "PREPARING":
      return "Preparing face recognition…";
    case "DOWNLOADING": {
      const d = s.download;
      if (!d) return "Downloading face recognition…";
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      return d.total
        ? `Downloading face recognition (${mb(d.loaded)} of ${mb(d.total)} MB)`
        : `Downloading face recognition (${mb(d.loaded)} MB)`;
    }
    case "VERIFYING":
      return "Verifying face recognition…";
    case "INITIALIZING":
      return "Starting face recognition…";
    case "WARMING_UP":
      return "Checking face recognition…";
    case "READY":
      return s.IDENTITY_NETWORK_AVAILABLE ? "Face recognition ready" : "Face recognition ready · offline";
    case "FAILED":
      return s.failure?.requiresReload
        ? "Face recognition could not start. Reload to try again."
        : "Face recognition could not start. Retry to continue.";
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}

/**
 * The engine for this page. Same detector, alignment, quality gates, PAD and
 * ArcFace as the rest of the SDK: it adds no second biometric code path.
 */
export class WasmBiometricEngine implements BiometricEngine {
  readonly platform: BiometricPlatform;
  readonly release = BIOMETRIC_ENGINE_RELEASE;
  private camera: BiometricCameraSession | null = null;
  private listeners = new Set<(s: BiometricEngineStatus) => void>();
  private unsubscribe: (() => void) | null = null;
  private onNetworkChange = () => this.emit();

  constructor(platform: BiometricPlatform = detectBiometricPlatform()) {
    this.platform = platform;
  }

  async initialize(): Promise<BiometricEngineStatus> {
    const snap = await ensureBiometricReady();
    return biometricEngineStatusFromReadiness(snap, this.platform);
  }

  getStatus(): BiometricEngineStatus {
    return biometricEngineStatusFromReadiness(getBiometricReadiness(), this.platform);
  }

  subscribe(listener: (status: BiometricEngineStatus) => void): () => void {
    this.listeners.add(listener);
    if (!this.unsubscribe) {
      const off = subscribeBiometricReadiness(() => this.emit());
      if (typeof window !== "undefined") {
        window.addEventListener("online", this.onNetworkChange);
        window.addEventListener("offline", this.onNetworkChange);
      }
      this.unsubscribe = () => {
        off();
        if (typeof window !== "undefined") {
          window.removeEventListener("online", this.onNetworkChange);
          window.removeEventListener("offline", this.onNetworkChange);
        }
      };
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribe?.();
        this.unsubscribe = null;
      }
    };
  }

  private emit(): void {
    const status = this.getStatus();
    for (const fn of this.listeners) {
      try {
        fn(status);
      } catch {
        /* a listener must not break the engine */
      }
    }
  }

  async openCamera(constraints: MediaTrackConstraints = { facingMode: "user" }): Promise<BiometricCameraSession> {
    if (this.camera) return this.camera;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("CAMERA_UNAVAILABLE: getUserMedia is not supported");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      stopStream(stream);
      throw err;
    }
    this.camera = { video, stream };
    return this.camera;
  }

  detectFace(frame: ImageData): Promise<DetectionResult> {
    return detectFacesInImageData(frame);
  }

  evaluateQuality(
    frame: ImageData,
    detection: DetectionResult,
    options?: Pick<FacePipelineOptions, "rejectMultipleFaces">,
  ): FaceCandidate | BiometricExtractError {
    return evaluateFaceCandidate(frame, detection, options);
  }

  createEmbedding(
    frame: ImageData,
    candidate: FaceCandidate,
    options?: FacePipelineOptions,
  ): Promise<BiometricExtractResult> {
    return embedFaceCandidate(frame, candidate, options);
  }

  closeCamera(): void {
    if (!this.camera) return;
    stopStream(this.camera.stream);
    this.camera.video.srcObject = null;
    this.camera = null;
  }

  dispose(): void {
    this.closeCamera();
    this.listeners.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

let sharedEngine: WasmBiometricEngine | null = null;

/** The page's biometric engine. */
export function getBiometricEngine(): BiometricEngine {
  sharedEngine ??= new WasmBiometricEngine();
  return sharedEngine;
}

/** The WASM module MediaPipe's FilesetResolver validates to detect SIMD support. */
const SIMD_PROBE = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function wasmSimdSupported(): boolean {
  try {
    return typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

export type BiometricPrefetchResult = {
  status: "complete" | "skipped" | "failed";
  reason?: "save-data" | "offline" | "app-bundle" | "unsupported";
  sources: Partial<Record<BiometricReleaseAssetId, BiometricAssetSource>>;
  failed: BiometricReleaseAssetId[];
};

const PREFETCH_PROGRESS: Record<BiometricReleaseAssetId, BiometricAssetId> = {
  "ort-wasm": "ort-wasm",
  "ort-loader": "ort-loader",
  "mediapipe-loader-simd": "mediapipe-loader",
  "mediapipe-loader-nosimd": "mediapipe-loader",
  "mediapipe-wasm-simd": "mediapipe-wasm",
  "mediapipe-wasm-nosimd": "mediapipe-wasm",
  "face-landmarker": "face-landmarker",
  arcface: "arcface",
};

let prefetchPromise: Promise<BiometricPrefetchResult> | null = null;

/**
 * Download, verify and cache the engine's assets ahead of sign-in.
 *
 * PRELOADING A MODEL IS NOT SCANNING A PERSON: this never opens the camera,
 * never reads a frame and never initializes inference. It skips itself when
 * the user asked to save data, when offline, and on native shells that
 * already carry the assets.
 */
export function prefetchBiometricAssets(
  options: { respectSaveData?: boolean } = {},
): Promise<BiometricPrefetchResult> {
  if (prefetchPromise) return prefetchPromise;
  prefetchPromise = (async (): Promise<BiometricPrefetchResult> => {
    const conn = (globalThis.navigator as Navigator & { connection?: { saveData?: boolean } } | undefined)?.connection;
    if (options.respectSaveData !== false && conn?.saveData) {
      return { status: "skipped", reason: "save-data", sources: {}, failed: [] };
    }
    if (!networkAvailable()) return { status: "skipped", reason: "offline", sources: {}, failed: [] };
    if (typeof caches === "undefined") return { status: "skipped", reason: "unsupported", sources: {}, failed: [] };

    const simd = wasmSimdSupported();
    const ids: BiometricReleaseAssetId[] = [
      "ort-loader",
      "ort-wasm",
      simd ? "mediapipe-loader-simd" : "mediapipe-loader-nosimd",
      simd ? "mediapipe-wasm-simd" : "mediapipe-wasm-nosimd",
      "face-landmarker",
      "arcface",
    ];
    const bundle = await getNativeBiometricBundle();
    if (bundle && ids.every((id) => bundle.dirs.has(biometricAssetDir(BIOMETRIC_RELEASE_ASSETS[id])))) {
      return { status: "skipped", reason: "app-bundle", sources: {}, failed: [] };
    }

    const sources: BiometricPrefetchResult["sources"] = {};
    const failed: BiometricReleaseAssetId[] = [];
    // One at a time: a background prefetch must not compete with the page.
    for (const id of ids) {
      try {
        const { source } = await loadBiometricAsset(BIOMETRIC_RELEASE_ASSETS[id], {
          progressId: PREFETCH_PROGRESS[id],
        });
        sources[id] = source;
      } catch {
        failed.push(id);
      }
    }
    return { status: failed.length ? "failed" : "complete", sources, failed };
  })().finally(() => {
    // A failed or skipped prefetch may be retried later; a complete one is a no-op anyway.
    prefetchPromise = null;
  });
  return prefetchPromise;
}

/** Run prefetchBiometricAssets when the browser is idle. Returns a cancel function. */
export function schedulePrefetchBiometricAssets(delayMs = 2_000): () => void {
  if (typeof window === "undefined") return () => undefined;
  let cancelled = false;
  let idleHandle: number | null = null;
  const run = () => {
    if (!cancelled) void prefetchBiometricAssets();
  };
  const timer = window.setTimeout(() => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) idleHandle = ric(run, { timeout: 10_000 });
    else run();
  }, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (idleHandle != null) {
      (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(idleHandle);
    }
  };
}
