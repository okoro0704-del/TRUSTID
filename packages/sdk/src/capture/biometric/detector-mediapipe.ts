/**
 * MediaPipe Face Landmarker detector ? real DNN face detection + landmarks.
 * Maps 478 landmarks to ArcFace 5-point set.
 *
 * Robustness notes:
 * - Prefer a renderable off-screen video (not display:none) at the capture layer.
 * - Detect on a square letterboxed canvas so NORM_RECT projection is well-defined
 *   for non-square camera frames (640?480), then map landmarks back to source size.
 * - GPU first, CPU fallback if GPU init fails or yields persistent empty detections.
 */
import { BIOMETRIC_ERROR_CODES } from "@trustid/shared";
import { loadBiometricAsset } from "./asset-delivery.js";
import { biometricFail, biometricUnavailable } from "./errors.js";
import {
  faceCaptureDiag,
  summarizeImageDataSignal,
} from "./face-capture-diag.js";
import {
  BIOMETRIC_RELEASE_ASSETS,
  MEDIAPIPE_WASM_BASE,
} from "./model-manifest.js";
import type { DetectedFace, FaceLandmarks5, Point2D } from "./types.js";

type FaceLandmarkerLike = {
  detect: (input: HTMLCanvasElement | HTMLVideoElement) => {
    faceLandmarks: Array<Array<{ x: number; y: number; z?: number }>>;
    faceBlendshapes?: Array<{
      categories: Array<{ categoryName: string; score: number }>;
    }>;
  };
  close?: () => void;
};

type DelegateKind = "GPU" | "CPU";

/** Cap hung GPU FaceLandmarker.createFromOptions so CPU fallback can still win. */
const MEDIAPIPE_GPU_CREATE_MS = 12_000;

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/** Prefer CPU when WebGL is missing or is a known software renderer.
 * Starting GPU createFromOptions on SwiftShader/etc can hang and block CPU fallback.
 */
function canUseMediapipeGpu(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    // Do not use failIfMajorPerformanceCaveat here ? we still need the context
    // to read the renderer string, then decide.
    const gl =
      (canvas.getContext("webgl2") as WebGLRenderingContext | null) ||
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return false;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";
    faceCaptureDiag({
      stage: "mediapipe_webgl_probe",
      component: "mediapipe",
      success: true,
      delegate: "GPU",
      errorMessage: renderer ? `renderer=${renderer.slice(0, 80)}` : "renderer=unknown",
    });
    if (!renderer) {
      // Safari often hides WEBGL_debug_renderer_info even when hardware WebGL
      // is available. Try the bounded GPU path; it falls back to CPU after 12s.
      return true;
    }
    if (
      /swiftshader|llvmpipe|softpipe|microsoft basic render|angle \(google\, vulkan|angle \(google\, swiftshader/i.test(
        renderer,
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

let landmarkerPromise: Promise<FaceLandmarkerLike> | null = null;
let activeDelegate: DelegateKind = "GPU";
let emptyDetectStreak = 0;

export type DetectorState = "IDLE" | "LOADING" | "READY" | "FAILED";
let detectorState: DetectorState = "IDLE";

export function getFaceDetectorStatus(): {
  state: DetectorState;
  delegate: DelegateKind;
} {
  return { state: detectorState, delegate: activeDelegate };
}

function trackDetector(
  load: Promise<FaceLandmarkerLike>,
): Promise<FaceLandmarkerLike> {
  detectorState = "LOADING";
  return load.then(
    (landmarker) => {
      detectorState = "READY";
      return landmarker;
    },
    (err: unknown) => {
      landmarkerPromise = null;
      detectorState = "FAILED";
      throw err;
    },
  );
}

/** MediaPipe Face Mesh indices approximating ArcFace 5-point set */
const IDX = {
  leftEye: 33,
  rightEye: 263,
  nose: 1,
  leftMouth: 61,
  rightMouth: 291,
} as const;

function toPixel(
  p: { x: number; y: number },
  width: number,
  height: number,
): Point2D {
  return { x: p.x * width, y: p.y * height };
}

function landmarks5FromMesh(
  mesh: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): FaceLandmarks5 {
  const get = (i: number) => {
    const p = mesh[i];
    if (!p) return { x: width / 2, y: height / 2 };
    return toPixel(p, width, height);
  };
  return {
    leftEye: get(IDX.leftEye),
    rightEye: get(IDX.rightEye),
    nose: get(IDX.nose),
    leftMouth: get(IDX.leftMouth),
    rightMouth: get(IDX.rightMouth),
  };
}

function boxFromMesh(
  mesh: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): DetectedFace["box"] {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of mesh) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    xMin: minX * width,
    yMin: minY * height,
    width: (maxX - minX) * width,
    height: (maxY - minY) * height,
  };
}

/**
 * Compute square letterbox geometry for a source frame (pure math).
 */
export function squareLetterboxGeometry(
  width: number,
  height: number,
): { side: number; offsetX: number; offsetY: number } {
  const side = Math.max(width, height);
  return {
    side,
    offsetX: Math.floor((side - width) / 2),
    offsetY: Math.floor((side - height) / 2),
  };
}

/**
 * Letterbox source ImageData onto a square ImageData (black bars).
 * Pure pixel copy ? jsdom-safe (no Canvas 2D).
 */
export function letterboxImageDataToSquareData(imageData: ImageData): {
  square: ImageData;
  side: number;
  offsetX: number;
  offsetY: number;
} {
  const { width, height, data } = imageData;
  const { side, offsetX, offsetY } = squareLetterboxGeometry(width, height);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = ((y + offsetY) * side + (x + offsetX)) * 4;
      out[di] = data[si] ?? 0;
      out[di + 1] = data[si + 1] ?? 0;
      out[di + 2] = data[si + 2] ?? 0;
      out[di + 3] = data[si + 3] ?? 255;
    }
  }
  const square = {
    data: out,
    width: side,
    height: side,
    colorSpace: imageData.colorSpace ?? "srgb",
  } as ImageData;
  return { square, side, offsetX, offsetY };
}

/**
 * Browsers reject ImageData-shaped objects in putImageData(); only a real
 * ImageData instance is accepted.
 */
export function toCanvasImageData(imageData: ImageData): ImageData {
  if (typeof ImageData === "undefined" || imageData instanceof ImageData) {
    return imageData;
  }
  const shaped = imageData as { data: ArrayLike<number>; width: number; height: number };
  return new ImageData(
    new Uint8ClampedArray(shaped.data),
    shaped.width,
    shaped.height,
  );
}

/**
 * Letterbox onto a square canvas for MediaPipe detect().
 */
export function letterboxImageDataToSquare(imageData: ImageData): {
  canvas: HTMLCanvasElement;
  side: number;
  offsetX: number;
  offsetY: number;
  scale: number;
} {
  const { side, offsetX, offsetY } = squareLetterboxGeometry(
    imageData.width,
    imageData.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw biometricFail(
      BIOMETRIC_ERROR_CODES.DETECTOR_ERROR,
      "Canvas 2D context unavailable",
    );
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, side, side);
  ctx.putImageData(toCanvasImageData(imageData), offsetX, offsetY);
  return { canvas, side, offsetX, offsetY, scale: 1 };
}

/** Map landmarks from square-letterboxed normalized space back to source pixels. */
export function mapSquareNormToSourcePixels(
  mesh: Array<{ x: number; y: number }>,
  sourceWidth: number,
  sourceHeight: number,
  side: number,
  offsetX: number,
  offsetY: number,
): Array<{ x: number; y: number }> {
  return mesh.map((p) => {
    const sx = p.x * side - offsetX;
    const sy = p.y * side - offsetY;
    return {
      x: Math.min(sourceWidth - 1, Math.max(0, sx)) / sourceWidth,
      y: Math.min(sourceHeight - 1, Math.max(0, sy)) / sourceHeight,
    };
  });
}

type VisionModule = {
  FaceLandmarker: {
    createFromOptions: (
      fileset: unknown,
      opts: Record<string, unknown>,
    ) => Promise<FaceLandmarkerLike>;
  };
  FilesetResolver: {
    forVisionTasks: (path: string) => Promise<unknown>;
  };
};

type DetectorAssets = {
  vision: VisionModule;
  fileset: Record<string, unknown>;
  model: Uint8Array;
  modelUrl: string;
};

const MIN_WASM_BYTES = 1024 * 1024;
let detectorAssetsPromise: Promise<DetectorAssets> | null = null;

function isWasmBinary(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= MIN_WASM_BYTES &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  );
}

function blobUrl(bytes: Uint8Array, type: string): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") {
    return null;
  }
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}

/**
 * Fetch the MediaPipe WASM binary and the face_landmarker task once, verify
 * them, and keep them for every create attempt. The GPU create timeout then
 * covers initialization only, and a CPU fallback never downloads again.
 */
/**
 * `_modelBaseUrl` is kept for callers of the legacy signature: asset locations
 * now come from the pinned release (asset-delivery.ts).
 */
function prepareDetectorAssets(_modelBaseUrl: string): Promise<DetectorAssets> {
  if (!detectorAssetsPromise) {
    detectorAssetsPromise = (async () => {
      const started = performance.now();
      const vision = (await import("@mediapipe/tasks-vision")) as unknown as VisionModule;
      // Same-origin, version-scoped assets: a new MediaPipe build never pairs
      // with an old loader or binary, and iOS Safari avoids opaque loads.
      const resolved = (await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE)) as Record<string, unknown>;
      const fileset: Record<string, unknown> = { ...resolved };
      // FilesetResolver picks the SIMD or non-SIMD build for this browser;
      // the bytes for that choice come from the pinned release.
      const resolvedWasm = typeof resolved.wasmBinaryPath === "string" ? resolved.wasmBinaryPath : null;
      const variant = resolvedWasm && /nosimd/.test(resolvedWasm) ? "nosimd" : "simd";
      const wasmAsset = BIOMETRIC_RELEASE_ASSETS[variant === "simd" ? "mediapipe-wasm-simd" : "mediapipe-wasm-nosimd"];
      const loaderAsset = BIOMETRIC_RELEASE_ASSETS[variant === "simd" ? "mediapipe-loader-simd" : "mediapipe-loader-nosimd"];
      const landmarkerAsset = BIOMETRIC_RELEASE_ASSETS["face-landmarker"];

      const wasmWork = resolvedWasm
        ? loadBiometricAsset(wasmAsset, { progressId: "mediapipe-wasm" }).then(({ bytes, url }) => {
            if (!isWasmBinary(bytes)) {
              throw new Error(`ASSET_NOT_BINARY: MediaPipe WASM is not a WebAssembly binary (${url})`);
            }
            const href = blobUrl(bytes, "application/wasm");
            if (href) fileset.wasmBinaryPath = href;
          })
        : Promise.resolve();
      // The loader script is small; if it cannot come from the release, the
      // versioned same-origin path FilesetResolver returned still works online.
      const loaderWork =
        typeof resolved.wasmLoaderPath === "string"
          ? loadBiometricAsset(loaderAsset, { progressId: "mediapipe-loader" })
              .then(({ bytes }) => {
                const href = blobUrl(bytes, "text/javascript");
                if (href) fileset.wasmLoaderPath = href;
              })
              .catch(() => undefined)
          : Promise.resolve();
      const modelWork = loadBiometricAsset(landmarkerAsset, { progressId: "face-landmarker" });
      const [{ bytes: model, url: modelUrl }] = await Promise.all([modelWork, wasmWork, loaderWork]);
      faceCaptureDiag({
        stage: "mediapipe_assets_ok",
        component: "mediapipe",
        success: true,
        ms: Math.round(performance.now() - started),
        modelUrl,
        imageWidth: model.byteLength,
      });
      return { vision, fileset, model, modelUrl };
    })().catch((err: unknown) => {
      detectorAssetsPromise = null;
      const msg = err instanceof Error ? err.message : String(err);
      faceCaptureDiag({
        stage: "mediapipe_assets_failed",
        component: "mediapipe",
        success: false,
        errorMessage: msg,
      });
      throw biometricUnavailable(`MediaPipe assets unavailable: ${msg}`);
    });
  }
  return detectorAssetsPromise;
}

async function loadFaceLandmarker(
  assets: DetectorAssets,
  delegate: DelegateKind,
): Promise<FaceLandmarkerLike> {
  const started = performance.now();
  try {
    const { FaceLandmarker } = assets.vision;
    faceCaptureDiag({
      stage: "face_landmarker_create_start",
      component: "mediapipe",
      success: true,
      modelUrl: assets.modelUrl,
      delegate,
      runningMode: "IMAGE",
    });
    const createStarted = performance.now();
    const landmarker = await FaceLandmarker.createFromOptions(assets.fileset, {
      baseOptions: {
        modelAssetBuffer: assets.model.slice(),
        delegate,
      },
      runningMode: "IMAGE",
      numFaces: 3,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });

    faceCaptureDiag({
      stage: "face_landmarker_create_ok",
      component: "mediapipe",
      success: true,
      ms: Math.round(performance.now() - createStarted),
      delegate,
      runningMode: "IMAGE",
      modelReady: true,
    });
    faceCaptureDiag({
      stage: "landmarker_loaded",
      component: "mediapipe",
      success: true,
      ms: Math.round(performance.now() - started),
      delegate,
      runningMode: "IMAGE",
      modelReady: true,
    });

    return landmarker;
  } catch (err) {
    faceCaptureDiag({
      stage: "landmarker_load_failed",
      component: "mediapipe",
      success: false,
      ms: Math.round(performance.now() - started),
      delegate,
      modelReady: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw biometricUnavailable(
      `MediaPipe Face Landmarker unavailable (${delegate}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getSharedFaceLandmarker(
  modelBaseUrl = "/models/trustid",
): Promise<FaceLandmarkerLike> {
  if (!landmarkerPromise) {
    landmarkerPromise = trackDetector((async () => {
      const assets = await prepareDetectorAssets(modelBaseUrl);
      if (!canUseMediapipeGpu()) {
        faceCaptureDiag({
          stage: "mediapipe_gpu_skipped_no_webgl",
          component: "mediapipe",
          success: true,
          delegate: "CPU",
        });
        activeDelegate = "CPU";
        return loadFaceLandmarker(assets, "CPU");
      }

      const gpuAttempt = loadFaceLandmarker(assets, "GPU");
      try {
        activeDelegate = "GPU";
        // GPU create can hang indefinitely on broken WebGL. Assets are already
        // local, so this bounds initialization only, never a download.
        return await Promise.race([
          gpuAttempt,
          rejectAfter(
            MEDIAPIPE_GPU_CREATE_MS,
            `MediaPipe GPU FaceLandmarker.create timed out after ${MEDIAPIPE_GPU_CREATE_MS}ms`,
          ),
        ]);
      } catch (gpuErr) {
        // A GPU landmarker that finishes after the timeout is never used.
        void gpuAttempt.then(
          (late) => late.close?.(),
          () => undefined,
        );
        faceCaptureDiag({
          stage: "mediapipe_gpu_failed_trying_cpu",
          component: "mediapipe",
          success: false,
          delegate: "GPU",
          errorMessage:
            gpuErr instanceof Error ? gpuErr.message : String(gpuErr),
        });
        activeDelegate = "CPU";
        return loadFaceLandmarker(assets, "CPU");
      }
    })());
  }
  return landmarkerPromise;
}

/**
 * Run one detection on a blank frame to prove the graph executes. The result
 * is checked for shape only; no camera frame is involved.
 */
export async function warmUpFaceLandmarker(
  modelBaseUrl = "/models/trustid",
): Promise<{ faces: number }> {
  const landmarker = await getSharedFaceLandmarker(modelBaseUrl);
  if (typeof document === "undefined") {
    throw biometricUnavailable("WARMUP_INVALID_OUTPUT: no document for detector warm-up");
  }
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 64, 64);
  }
  try {
    const result = landmarker.detect(canvas);
    if (!result || !Array.isArray(result.faceLandmarks)) {
      throw biometricUnavailable("WARMUP_INVALID_OUTPUT: detector returned no result");
    }
    return { faces: result.faceLandmarks.length };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Test/dev helper ? drop cached landmarker so the next call reloads. */
export function resetSharedFaceLandmarkerForTests(): void {
  landmarkerPromise = null;
  detectorAssetsPromise = null;
  emptyDetectStreak = 0;
  activeDelegate = "GPU";
  detectorState = "IDLE";
}

async function forceCpuLandmarker(
  modelBaseUrl: string,
): Promise<FaceLandmarkerLike> {
  const previous = landmarkerPromise;
  emptyDetectStreak = 0;
  activeDelegate = "CPU";
  landmarkerPromise = trackDetector(
    prepareDetectorAssets(modelBaseUrl).then((assets) => loadFaceLandmarker(assets, "CPU")),
  );
  const cpu = await landmarkerPromise;
  void previous?.then(
    (old) => {
      if (old !== cpu) old.close?.();
    },
    () => undefined,
  );
  return cpu;
}

export type DetectionResult = {
  faces: DetectedFace[];
  blendshapes?: Array<Record<string, number>>;
  /** Dimensions of the canvas actually handed to MediaPipe. */
  input?: { width: number; height: number; ms: number };
};

export async function detectFacesInImageData(
  imageData: ImageData,
  modelBaseUrl?: string,
): Promise<DetectionResult> {
  const base = modelBaseUrl ?? "/models/trustid";
  const signal = summarizeImageDataSignal(imageData);
  const started = performance.now();

  const { canvas, side, offsetX, offsetY } = letterboxImageDataToSquare(imageData);
  const landmarker = await getSharedFaceLandmarker(base);
  let result = landmarker.detect(canvas);

  const detectMs = Math.round(performance.now() - started);
  let faceCount = result.faceLandmarks?.length ?? 0;

  faceCaptureDiag({
    stage: "mediapipe_detect",
    ms: detectMs,
    imageWidth: imageData.width,
    imageHeight: imageData.height,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    hasNonZeroPixels: signal.hasNonZeroPixels,
    sampledNonZeroRatio: Number(signal.sampledNonZeroRatio.toFixed(3)),
    meanLumaApprox: signal.meanLumaApprox,
    faceLandmarksCount: faceCount,
    faceBlendshapesCount: result.faceBlendshapes?.length ?? 0,
    delegate: activeDelegate,
    runningMode: "IMAGE",
    squarePadded: side !== imageData.width || side !== imageData.height,
    modelReady: true,
  });

  // Persistent empty detections on GPU ? one CPU retry (fail-closed if still empty).
  if (faceCount === 0 && signal.hasNonZeroPixels) {
    emptyDetectStreak += 1;
    if (activeDelegate === "GPU" && emptyDetectStreak >= 3) {
      faceCaptureDiag({
        stage: "mediapipe_delegate_fallback",
        delegate: "CPU",
        faceLandmarksCount: 0,
        hasNonZeroPixels: true,
      });
      const cpu = await forceCpuLandmarker(base);
      result = cpu.detect(canvas);
      faceCount = result.faceLandmarks?.length ?? 0;
      faceCaptureDiag({
        stage: "mediapipe_detect_cpu_retry",
        faceLandmarksCount: faceCount,
        delegate: "CPU",
        squarePadded: true,
      });
    }
  } else if (faceCount > 0) {
    emptyDetectStreak = 0;
  }

  canvas.width = 0;
  canvas.height = 0;

  const alignmentIdx = Object.values(IDX);
  const faces: DetectedFace[] = (result.faceLandmarks ?? []).map((mesh) => {
    const landmarksInFrame = alignmentIdx.every((i) => {
      const p = mesh[i];
      if (!p) return false;
      const sx = p.x * side - offsetX;
      const sy = p.y * side - offsetY;
      return sx >= 0 && sy >= 0 && sx <= imageData.width && sy <= imageData.height;
    });
    const mapped =
      side === imageData.width && side === imageData.height
        ? mesh
        : mapSquareNormToSourcePixels(
            mesh,
            imageData.width,
            imageData.height,
            side,
            offsetX,
            offsetY,
          );
    const landmarks = landmarks5FromMesh(
      mapped,
      imageData.width,
      imageData.height,
    );
    const box = boxFromMesh(mapped, imageData.width, imageData.height);
    return {
      box,
      confidence: 0.9,
      landmarks,
      landmarksInFrame,
    };
  });

  const blendshapes = (result.faceBlendshapes ?? []).map((b) => {
    const map: Record<string, number> = {};
    for (const c of b.categories ?? []) {
      map[c.categoryName] = c.score;
    }
    return map;
  });

  return {
    faces,
    blendshapes,
    input: { width: side, height: side, ms: detectMs },
  };
}

export function selectPrimaryFace(faces: DetectedFace[]): DetectedFace | null {
  if (faces.length === 0) return null;
  return [...faces].sort(
    (a, b) => b.box.width * b.box.height - a.box.width * a.box.height,
  )[0]!;
}
