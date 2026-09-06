/**
 * MediaPipe Face Landmarker detector — real DNN face detection + landmarks.
 * Maps 478 landmarks to ArcFace 5-point set.
 */
import { BIOMETRIC_ERROR_CODES } from "@trustid/shared";
import { biometricFail, biometricUnavailable } from "./errors.js";
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

let landmarkerPromise: Promise<FaceLandmarkerLike> | null = null;

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

async function loadFaceLandmarker(
  modelBaseUrl: string,
): Promise<FaceLandmarkerLike> {
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

    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath,
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numFaces: 3,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
  } catch (err) {
    throw biometricUnavailable(
      `MediaPipe Face Landmarker unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getSharedFaceLandmarker(
  modelBaseUrl = "/models/trustid",
): Promise<FaceLandmarkerLike> {
  if (!landmarkerPromise) {
    landmarkerPromise = loadFaceLandmarker(modelBaseUrl).catch((err) => {
      landmarkerPromise = null;
      throw err;
    });
  }
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
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw biometricFail(
      BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      "Canvas 2D context unavailable",
    );
  }
  ctx.putImageData(imageData, 0, 0);

  const landmarker = await getSharedFaceLandmarker(modelBaseUrl);
  const result = landmarker.detect(canvas);
  canvas.width = 0;
  canvas.height = 0;

  const faces: DetectedFace[] = (result.faceLandmarks ?? []).map((mesh) => {
    const landmarks = landmarks5FromMesh(mesh, imageData.width, imageData.height);
    const box = boxFromMesh(mesh, imageData.width, imageData.height);
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
