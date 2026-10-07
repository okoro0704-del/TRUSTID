/**
 * Page-level owner of biometric readiness.
 *
 *   runtime  : ORT module + WASM binary + one probe inference (ORT init once)
 *   detector : MediaPipe WASM + face_landmarker.task + FaceLandmarker
 *   embedder : ArcFace model bytes (SHA-256 verified) + ORT session
 *   warmup   : one detection on a blank frame + one ArcFace run on a constant
 *              tensor, checked for shape only
 *
 * BIOMETRIC_READY means all four succeeded. Runtime, detector and embedder
 * load in parallel; warm-up runs after all three. Each component keeps its
 * READY result, so a retry only redoes what failed: a failed embedder
 * download retries without touching the runtime, and ORT's own init still
 * runs at most once per page (ort-runtime enforces that).
 *
 * Reports carry states, timings, asset URLs, byte counts and failure
 * categories only. Never frames, landmarks, embeddings or templates.
 */
import { getAssetProgress, onAssetProgress, type BiometricAssetId } from "./asset-progress.js";
import { pruneBiometricAssets } from "./biometric-asset-cache.js";
import {
  getFaceDetectorStatus,
  getSharedFaceLandmarker,
  warmUpFaceLandmarker,
} from "./detector-mediapipe.js";
import { faceCaptureDiag, sanitizeInitError } from "./face-capture-diag.js";
import { getOrtRuntimeStatus, initOrtRuntime } from "./ort-runtime.js";
import {
  getArcFaceEmbedderState,
  getArcFaceSession,
  warmUpArcFace,
} from "./recognizer-arcface.js";

export const BIOMETRIC_READINESS = {
  IDLE: "IDLE",
  RUNTIME_LOADING: "RUNTIME_LOADING",
  RUNTIME_READY: "RUNTIME_READY",
  RUNTIME_FAILED: "RUNTIME_FAILED",
  DETECTOR_LOADING: "DETECTOR_LOADING",
  DETECTOR_READY: "DETECTOR_READY",
  DETECTOR_FAILED: "DETECTOR_FAILED",
  EMBEDDER_LOADING: "EMBEDDER_LOADING",
  EMBEDDER_READY: "EMBEDDER_READY",
  EMBEDDER_FAILED: "EMBEDDER_FAILED",
  WARMUP_RUNNING: "WARMUP_RUNNING",
  WARMUP_READY: "WARMUP_READY",
  WARMUP_FAILED: "WARMUP_FAILED",
  BIOMETRIC_READY: "BIOMETRIC_READY",
} as const;

export type BiometricReadinessStage =
  (typeof BIOMETRIC_READINESS)[keyof typeof BIOMETRIC_READINESS];

export const BIOMETRIC_FAILURE_CATEGORY = {
  ASSET_MISSING: "ASSET_MISSING",
  ASSET_NOT_BINARY: "ASSET_NOT_BINARY",
  ASSET_INTEGRITY: "ASSET_INTEGRITY",
  ASSET_STALLED: "ASSET_STALLED",
  NETWORK: "NETWORK",
  RUNTIME_INIT: "RUNTIME_INIT",
  SESSION_CREATE: "SESSION_CREATE",
  WARMUP_INVALID: "WARMUP_INVALID",
  UNKNOWN: "UNKNOWN",
} as const;

export type BiometricFailureCategory =
  (typeof BIOMETRIC_FAILURE_CATEGORY)[keyof typeof BIOMETRIC_FAILURE_CATEGORY];

export type BiometricComponent = "runtime" | "detector" | "embedder" | "warmup";
export type BiometricComponentState = "IDLE" | "LOADING" | "READY" | "FAILED";

export type BiometricComponentReport = {
  state: BiometricComponentState;
  attempts: number;
  durationMs: number | null;
  assetUrl: string | null;
  bytesLoaded: number | null;
  bytesTotal: number | null;
  fromCache: boolean | null;
  failureCategory: BiometricFailureCategory | null;
  error: string | null;
};

export type BiometricReadinessSnapshot = {
  stage: BiometricReadinessStage;
  ready: boolean;
  failed: boolean;
  loading: boolean;
  /** Only a page reload can recover (ORT runtime init failed, or a versioned asset is gone). */
  requiresReload: boolean;
  runtime: BiometricComponentReport;
  detector: BiometricComponentReport;
  embedder: BiometricComponentReport;
  warmup: BiometricComponentReport;
  /** READY/FAILED transitions in the order they happened. */
  transitions: BiometricReadinessStage[];
  /** Initialization passes started on this page. */
  passes: number;
};

type MutableReport = {
  state: BiometricComponentState;
  attempts: number;
  startedAt: number | null;
  durationMs: number | null;
  failureCategory: BiometricFailureCategory | null;
  error: string | null;
};

const COMPONENT_ASSETS: Record<BiometricComponent, BiometricAssetId[]> = {
  runtime: ["ort-wasm", "ort-loader"],
  detector: ["face-landmarker", "mediapipe-wasm", "mediapipe-loader"],
  embedder: ["arcface"],
  warmup: [],
};

const STAGE_FOR: Record<BiometricComponent, { ready: BiometricReadinessStage; failed: BiometricReadinessStage; loading: BiometricReadinessStage }> = {
  runtime: { ready: "RUNTIME_READY", failed: "RUNTIME_FAILED", loading: "RUNTIME_LOADING" },
  detector: { ready: "DETECTOR_READY", failed: "DETECTOR_FAILED", loading: "DETECTOR_LOADING" },
  embedder: { ready: "EMBEDDER_READY", failed: "EMBEDDER_FAILED", loading: "EMBEDDER_LOADING" },
  warmup: { ready: "WARMUP_READY", failed: "WARMUP_FAILED", loading: "WARMUP_RUNNING" },
};

const MAX_TRANSITIONS = 40;
const PROGRESS_EMIT_MS = 250;

function freshReport(): MutableReport {
  return { state: "IDLE", attempts: 0, startedAt: null, durationMs: null, failureCategory: null, error: null };
}

let reports: Record<BiometricComponent, MutableReport> = {
  runtime: freshReport(),
  detector: freshReport(),
  embedder: freshReport(),
  warmup: freshReport(),
};
let transitions: BiometricReadinessStage[] = [];
let inflight: Promise<BiometricReadinessSnapshot> | null = null;
let passes = 0;
let pruned = false;
const listeners = new Set<(s: BiometricReadinessSnapshot) => void>();
let unsubscribeProgress: (() => void) | null = null;
let lastProgressEmit = 0;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function classifyBiometricFailure(err: unknown): BiometricFailureCategory {
  const msg = err instanceof Error ? err.message : String(err);
  if (/WARMUP_INVALID_OUTPUT/.test(msg)) return "WARMUP_INVALID";
  if (/ASSET_MISSING/.test(msg)) return "ASSET_MISSING";
  if (/ASSET_NOT_BINARY/.test(msg)) return "ASSET_NOT_BINARY";
  if (/ASSET_INTEGRITY_MISMATCH/.test(msg)) return "ASSET_INTEGRITY";
  if (/ASSET_STALLED/.test(msg)) return "ASSET_STALLED";
  if (/ASSET_NETWORK_ERROR|ASSET_HTTP_ERROR|ASSET_INCOMPLETE/.test(msg)) return "NETWORK";
  if (/integrity/i.test(msg)) return "ASSET_INTEGRITY";
  if (/BIOMETRIC_RUNTIME_ASSETS_UNAVAILABLE|failed to fetch|network/i.test(msg)) return "NETWORK";
  if (/BIOMETRIC_RUNTIME_FAILED|BIOMETRIC_RUNTIME_IMPORT_FAILED/.test(msg)) return "RUNTIME_INIT";
  if (/BIOMETRIC_SESSION_FAILED|BIOMETRIC_RUNTIME_PROBE_FAILED|createFromOptions|FaceLandmarker|timed out/i.test(msg)) {
    return "SESSION_CREATE";
  }
  return "UNKNOWN";
}

function assetReport(component: BiometricComponent): Pick<BiometricComponentReport, "assetUrl" | "bytesLoaded" | "bytesTotal" | "fromCache"> {
  let assetUrl: string | null = null;
  let seen = false;
  let loaded = 0;
  let total = 0;
  let totalKnown = true;
  let allCached = true;
  for (const id of COMPONENT_ASSETS[component]) {
    const p = getAssetProgress(id);
    if (!p) continue;
    seen = true;
    assetUrl ??= p.url;
    loaded += p.loaded;
    if (p.total == null) totalKnown = false;
    else total += p.total;
    if (!p.fromCache) allCached = false;
  }
  if (!seen) return { assetUrl: null, bytesLoaded: null, bytesTotal: null, fromCache: null };
  return {
    assetUrl,
    bytesLoaded: loaded,
    bytesTotal: totalKnown ? total : null,
    fromCache: allCached,
  };
}

/** Pick up failures that happened after a component reported READY. */
function reconcile(): void {
  if (getOrtRuntimeStatus().requiresReload && reports.runtime.state !== "FAILED") {
    setFailed("runtime", new Error("BIOMETRIC_RUNTIME_FAILED: runtime init failed (reload required)"));
  }
  if (reports.detector.state === "READY" && getFaceDetectorStatus().state === "FAILED") {
    setFailed("detector", new Error("detector failed after it was ready"));
  }
  if (reports.embedder.state === "READY" && getArcFaceEmbedderState() === "FAILED") {
    setFailed("embedder", new Error("embedder failed after it was ready"));
  }
  if (
    reports.warmup.state === "READY" &&
    (reports.runtime.state !== "READY" || reports.detector.state !== "READY" || reports.embedder.state !== "READY")
  ) {
    reports.warmup = freshReport();
  }
}

function stageOf(): BiometricReadinessStage {
  const { runtime, detector, embedder, warmup } = reports;
  if (runtime.state === "READY" && detector.state === "READY" && embedder.state === "READY" && warmup.state === "READY") {
    return "BIOMETRIC_READY";
  }
  for (const c of ["runtime", "detector", "embedder", "warmup"] as const) {
    if (reports[c].state === "FAILED") return STAGE_FOR[c].failed;
  }
  for (const c of ["warmup", "runtime", "detector", "embedder"] as const) {
    if (reports[c].state === "LOADING") return STAGE_FOR[c].loading;
  }
  if (embedder.state === "READY") return "EMBEDDER_READY";
  if (detector.state === "READY") return "DETECTOR_READY";
  if (runtime.state === "READY") return "RUNTIME_READY";
  return "IDLE";
}

function publicReport(component: BiometricComponent): BiometricComponentReport {
  const r = reports[component];
  return {
    state: r.state,
    attempts: r.attempts,
    durationMs:
      r.durationMs ?? (r.state === "LOADING" && r.startedAt != null ? Math.round(now() - r.startedAt) : null),
    ...assetReport(component),
    failureCategory: r.failureCategory,
    error: r.error,
  };
}

export function getBiometricReadiness(): BiometricReadinessSnapshot {
  reconcile();
  const stage = stageOf();
  const failed = Object.values(reports).some((r) => r.state === "FAILED");
  const loading = inflight !== null || Object.values(reports).some((r) => r.state === "LOADING");
  const missingVersionedAsset = Object.values(reports).some(
    (r) => r.state === "FAILED" && r.failureCategory === "ASSET_MISSING",
  );
  return {
    stage,
    ready: stage === "BIOMETRIC_READY",
    failed,
    loading,
    requiresReload: getOrtRuntimeStatus().requiresReload || missingVersionedAsset,
    runtime: publicReport("runtime"),
    detector: publicReport("detector"),
    embedder: publicReport("embedder"),
    warmup: publicReport("warmup"),
    transitions: [...transitions],
    passes,
  };
}

function emit(): void {
  if (listeners.size === 0) return;
  const snap = getBiometricReadiness();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* a listener must not break initialization */
    }
  }
}

function record(stage: BiometricReadinessStage): void {
  transitions.push(stage);
  if (transitions.length > MAX_TRANSITIONS) transitions = transitions.slice(-MAX_TRANSITIONS);
}

function setFailed(component: BiometricComponent, err: unknown): void {
  const r = reports[component];
  r.state = "FAILED";
  r.durationMs = r.startedAt != null ? Math.round(now() - r.startedAt) : null;
  r.failureCategory = classifyBiometricFailure(err);
  r.error = sanitizeInitError(err);
  record(STAGE_FOR[component].failed);
  faceCaptureDiag({
    stage: `readiness_${component}_failed`,
    component: "readiness",
    success: false,
    ms: r.durationMs ?? undefined,
    modelUrl: assetReport(component).assetUrl ?? undefined,
    errorCode: r.failureCategory,
    errorMessage: r.error,
  });
}

function runComponent(component: BiometricComponent, work: () => Promise<unknown>): Promise<boolean> {
  const r = reports[component];
  if (r.state === "READY") return Promise.resolve(true);
  r.state = "LOADING";
  r.attempts += 1;
  r.startedAt = now();
  r.durationMs = null;
  r.failureCategory = null;
  r.error = null;
  emit();
  return work().then(
    () => {
      r.state = "READY";
      r.durationMs = Math.round(now() - (r.startedAt ?? now()));
      record(STAGE_FOR[component].ready);
      faceCaptureDiag({
        stage: `readiness_${component}_ready`,
        component: "readiness",
        success: true,
        ms: r.durationMs,
        modelUrl: assetReport(component).assetUrl ?? undefined,
      });
      emit();
      return true;
    },
    (err: unknown) => {
      setFailed(component, err);
      emit();
      return false;
    },
  );
}

function watchProgress(): void {
  if (unsubscribeProgress) return;
  unsubscribeProgress = onAssetProgress(() => {
    const t = now();
    if (t - lastProgressEmit < PROGRESS_EMIT_MS) return;
    lastProgressEmit = t;
    emit();
  });
}

export type EnsureBiometricReadyOptions = {
  modelBaseUrl?: string;
};

/**
 * Bring the biometric stack to BIOMETRIC_READY. Never rejects: resolves with
 * the snapshot, which is either ready or names what failed. Concurrent and
 * repeated calls share one in-flight pass; a call after a failure retries
 * only the failed components.
 */
export function ensureBiometricReady(
  options: EnsureBiometricReadyOptions = {},
): Promise<BiometricReadinessSnapshot> {
  reconcile();
  if (stageOf() === "BIOMETRIC_READY") return Promise.resolve(getBiometricReadiness());
  if (inflight) return inflight;
  if (getOrtRuntimeStatus().requiresReload) return Promise.resolve(getBiometricReadiness());

  const base = options.modelBaseUrl ?? "/models/trustid";
  passes += 1;
  watchProgress();
  if (!pruned) {
    pruned = true;
    void pruneBiometricAssets();
  }
  faceCaptureDiag({ stage: "readiness_pass_start", component: "readiness", success: true });

  inflight = (async () => {
    const [runtimeOk, detectorOk, embedderOk] = await Promise.all([
      runComponent("runtime", () => initOrtRuntime()),
      runComponent("detector", () => getSharedFaceLandmarker(base)),
      runComponent("embedder", () => getArcFaceSession(base)),
    ]);
    if (runtimeOk && detectorOk && embedderOk) {
      await runComponent("warmup", async () => {
        await warmUpFaceLandmarker(base);
        await warmUpArcFace(base);
      });
    }
    if (stageOf() === "BIOMETRIC_READY") record("BIOMETRIC_READY");
    return getBiometricReadiness();
  })().finally(() => {
    inflight = null;
    emit();
  });
  return inflight;
}

/** Same as ensureBiometricReady; named for the "Retry biometric initialization" action. */
export const retryBiometricInit = ensureBiometricReady;

export function isBiometricReady(): boolean {
  reconcile();
  return stageOf() === "BIOMETRIC_READY";
}

export function subscribeBiometricReadiness(
  fn: (snapshot: BiometricReadinessSnapshot) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export type BiometricReadinessController = {
  ensureReady: () => Promise<BiometricReadinessSnapshot>;
  snapshot: () => BiometricReadinessSnapshot;
  subscribe: (fn: (snapshot: BiometricReadinessSnapshot) => void) => () => void;
};

export const biometricReadiness: BiometricReadinessController = {
  ensureReady: () => ensureBiometricReady(),
  snapshot: getBiometricReadiness,
  subscribe: subscribeBiometricReadiness,
};

/** Test helper: forget component results (does not reset the loaders). */
export function resetBiometricReadinessForTests(): void {
  reports = {
    runtime: freshReport(),
    detector: freshReport(),
    embedder: freshReport(),
    warmup: freshReport(),
  };
  transitions = [];
  inflight = null;
  passes = 0;
  pruned = false;
  listeners.clear();
  unsubscribeProgress?.();
  unsubscribeProgress = null;
  lastProgressEmit = 0;
}
