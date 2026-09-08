/**
 * MediaPipe Face Landmarker detector ù real DNN face detection + landmarks.
 * Maps 478 landmarks to ArcFace 5-point set.
 *
 * Robustness notes:
 * - Prefer a renderable off-screen video (not display:none) at the capture layer.
 * - Detect on a square letterboxed canvas so NORM_RECT projection is well-defined
 *   for non-square camera frames (640ù480), then map landmarks back to source size.
 * - GPU first, CPU fallback if GPU init fails or yields persistent empty detections.
 */
import { BIOMETRIC_ERROR_CODES } from "@trustid/shared";
import { biometricFail, biometricUnavailable } from "./errors.js";
import {
  faceCaptureDiag,
  summarizeImageDataSignal,
} from "./face-capture-diag.js";
import { MEDIAPIPE_FACE_LANDMARKER_ARTIFACT } from "./model-manifest.js";
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

let landmarkerPromise: Promise<FaceLandmarkerLike> | null = null;
let activeDelegate: DelegateKind = "GPU";
let emptyDetectStreak = 0;

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
 * Pure pixel copy ó jsdom-safe (no Canvas 2D).
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
 * Letterbox onto a square canvas for MediaPipe detect().
 */
export function letterboxImageDataToSquare(imageData: ImageData): {
  canvas: HTMLCanvasElement;
  side: number;
  offsetX: number;
  offsetY: number;
  scale: number;
} {
  const { square, side, offsetX, offsetY } =
    letterboxImageDataToSquareData(imageData);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw biometricFail(
      BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      "Canvas 2D context unavailable",
    );
  }
  ctx.putImageData(square, 0, 0);
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

async function loadFaceLandmarker(
  modelBaseUrl: string,
  delegate: DelegateKind,
): Promise<FaceLandmarkerLike> {
  const started = performance.now();
  try {
    const vision = await import("@mediapipe/tasks-vision");
    const { FaceLandmarker, FilesetResolver } = vision as {
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

    const wasmPath =
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
    const fileset = await FilesetResolver.forVisionTasks(wasmPath);
    const modelAssetPath = `${modelBaseUrl.replace(/\/$/, "")}/${MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.relativePath}`;

    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath,
        delegate,
      },
      runningMode: "IMAGE",
      numFaces: 3,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });

    faceCaptureDiag({
      stage: "landmarker_loaded",
      ms: Math.round(performance.now() - started),
      delegate,
      runningMode: "IMAGE",
      modelReady: true,
    });

    return landmarker;
  } catch (err) {
    faceCaptureDiag({
      stage: "landmarker_load_failed",
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
    landmarkerPromise = (async () => {
      try {
        activeDelegate = "GPU";
        return await loadFaceLandmarker(modelBaseUrl, "GPU");
      } catch {
        activeDelegate = "CPU";
        return loadFaceLandmarker(modelBaseUrl, "CPU");
      }
    })().catch((err) => {
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

/** Test/dev helper ù drop cached landmarker so the next call reloads. */
export function resetSharedFaceLandmarkerForTests(): void {
  landmarkerPromise = null;
  emptyDetectStreak = 0;
  activeDelegate = "GPU";
}

async function forceCpuLandmarker(
  modelBaseUrl: string,
): Promise<FaceLandmarkerLike> {
  landmarkerPromise = null;
  emptyDetectStreak = 0;
  activeDelegate = "CPU";
  landmarkerPromise = loadFaceLandmarker(modelBaseUrl, "CPU").catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

export type DetectionResult = {
  faces: DetectedFace[];
  blendshapes?: Array<Record<string, number>>;
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

  const faces: DetectedFace[] = (result.faceLandmarks ?? []).map((mesh) => {
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
    };
  });

  const blendshapes = (result.faceBlendshapes ?? []).map((b) => {
    const map: Record<string, number> = {};
    for (const c of b.categories ?? []) {
      map[c.categoryName] = c.score;
    }
    return map;
  });

  return { faces, blendshapes };
}

export function selectPrimaryFace(faces: DetectedFace[]): DetectedFace | null {
  if (faces.length === 0) return null;
  return [...faces].sort(
    (a, b) => b.box.width * b.box.height - a.box.width * a.box.height,
  )[0]!;
}
