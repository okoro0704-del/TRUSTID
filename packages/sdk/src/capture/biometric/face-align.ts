/**
 * ArcFace 5-point similarity-transform alignment ? 112×112 RGB float tensor.
 * Reference template matches InsightFace / insightface.utils.face_align.
 */
import type { FaceLandmarks5, Point2D } from "./types.js";

/** ArcFace canonical 5-point template for 112×112 (InsightFace standard). */
export const ARCFACE_DST_112: FaceLandmarks5 = {
  leftEye: { x: 38.2946, y: 51.6963 },
  rightEye: { x: 73.5318, y: 51.5014 },
  nose: { x: 56.0252, y: 71.7366 },
  leftMouth: { x: 41.5493, y: 92.3655 },
  rightMouth: { x: 70.7299, y: 92.2041 },
};

const OUT = 112;

function landmarksToArray(l: FaceLandmarks5): Point2D[] {
  return [l.leftEye, l.rightEye, l.nose, l.leftMouth, l.rightMouth];
}

/**
 * Estimate similarity transform (Umeyama) from src ? dst points.
 * Returns [a, b, tx, ty] where x' = a*x - b*y + tx, y' = b*x + a*y + ty.
 */
export function estimateSimilarityTransform(
  src: Point2D[],
  dst: Point2D[],
): [number, number, number, number] {
  const n = Math.min(src.length, dst.length);
  let srcMeanX = 0;
  let srcMeanY = 0;
  let dstMeanX = 0;
  let dstMeanY = 0;
  for (let i = 0; i < n; i++) {
    srcMeanX += src[i]!.x;
    srcMeanY += src[i]!.y;
    dstMeanX += dst[i]!.x;
    dstMeanY += dst[i]!.y;
  }
  srcMeanX /= n;
  srcMeanY /= n;
  dstMeanX /= n;
  dstMeanY /= n;

  let srcVar = 0;
  let cov00 = 0;
  let cov01 = 0;
  let cov10 = 0;
  let cov11 = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]!.x - srcMeanX;
    const sy = src[i]!.y - srcMeanY;
    const dx = dst[i]!.x - dstMeanX;
    const dy = dst[i]!.y - dstMeanY;
    srcVar += sx * sx + sy * sy;
    cov00 += sx * dx;
    cov01 += sx * dy;
    cov10 += sy * dx;
    cov11 += sy * dy;
  }
  srcVar /= n;
  cov00 /= n;
  cov01 /= n;
  cov10 /= n;
  cov11 /= n;

  const det = cov00 * cov11 - cov01 * cov10;
  const trace = cov00 + cov11;
  let a: number;
  let b: number;
  if (srcVar < 1e-9) {
    a = 1;
    b = 0;
  } else {
    const scale = Math.sqrt(Math.max(0, (trace * trace + (cov01 - cov10) * (cov01 - cov10))) / (srcVar * srcVar));
    // SVD-free 2x2 Umeyama for planar similarity
    const d = Math.sign(det === 0 ? 1 : det);
    const norm = Math.hypot(trace, cov01 - cov10);
    if (norm < 1e-9) {
      a = scale;
      b = 0;
    } else {
      a = (scale * trace) / norm;
      b = (scale * d * (cov01 - cov10)) / norm;
    }
    // Fallback classic Kabsch-style for 2D
    const mu = Math.atan2(cov01 - cov10, cov00 + cov11);
    const s = Math.sqrt(
      Math.max(
        1e-12,
        ((cov00 + cov11) * (cov00 + cov11) + (cov01 - cov10) * (cov01 - cov10)) /
          (srcVar * srcVar),
      ),
    );
    a = s * Math.cos(mu);
    b = s * Math.sin(mu);
  }

  const tx = dstMeanX - (a * srcMeanX - b * srcMeanY);
  const ty = dstMeanY - (b * srcMeanX + a * srcMeanY);
  return [a, b, tx, ty];
}

function sampleBilinear(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number] {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) {
    const xi = Math.min(width - 1, Math.max(0, Math.floor(x)));
    const yi = Math.min(height - 1, Math.max(0, Math.floor(y)));
    const i = (yi * width + xi) * 4;
    return [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0];
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const dx = x - x0;
  const dy = y - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x0 + 1) * 4;
  const i01 = ((y0 + 1) * width + x0) * 4;
  const i11 = ((y0 + 1) * width + x0 + 1) * 4;
  const r =
    (rgba[i00]! * (1 - dx) + rgba[i10]! * dx) * (1 - dy) +
    (rgba[i01]! * (1 - dx) + rgba[i11]! * dx) * dy;
  const g =
    (rgba[i00 + 1]! * (1 - dx) + rgba[i10 + 1]! * dx) * (1 - dy) +
    (rgba[i01 + 1]! * (1 - dx) + rgba[i11 + 1]! * dx) * dy;
  const b =
    (rgba[i00 + 2]! * (1 - dx) + rgba[i10 + 2]! * dx) * (1 - dy) +
    (rgba[i01 + 2]! * (1 - dx) + rgba[i11 + 2]! * dx) * dy;
  return [r, g, b];
}

/**
 * Warp face to 112×112 and emit NCHW float32 with ArcFace normalization (x-127.5)/128.
 */
export function alignFaceToArcFace112(
  imageData: ImageData,
  landmarks: FaceLandmarks5,
): Float32Array {
  const src = landmarksToArray(landmarks);
  const dst = landmarksToArray(ARCFACE_DST_112);
  const [a, b, tx, ty] = estimateSimilarityTransform(src, dst);

  // Inverse map: for each output pixel, sample source
  // Forward: x_d = a*x_s - b*y_s + tx; y_d = b*x_s + a*y_s + ty
  // Inverse: x_s = (a*(x_d-tx) + b*(y_d-ty)) / (a^2+b^2)
  //          y_s = (-b*(x_d-tx) + a*(y_d-ty)) / (a^2+b^2)
  const denom = a * a + b * b || 1;
  const out = new Float32Array(1 * 3 * OUT * OUT);
  const { data, width, height } = imageData;

  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      const xd = x - tx;
      const yd = y - ty;
      const xs = (a * xd + b * yd) / denom;
      const ys = (-b * xd + a * yd) / denom;
      const [r, g, bl] = sampleBilinear(data, width, height, xs, ys);
      const idx = y * OUT + x;
      out[0 * OUT * OUT + idx] = (r - 127.5) / 128;
      out[1 * OUT * OUT + idx] = (g - 127.5) / 128;
      out[2 * OUT * OUT + idx] = (bl - 127.5) / 128;
    }
  }
  return out;
}

export function l2Normalize(v: ArrayLike<number>): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return Array.from(v);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Mean of L2-normalized ArcFace embeddings, then re-normalize (standard multi-shot). */
export function meanNormalizeEmbeddings(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0]!.length;
  const acc = new Array<number>(dims).fill(0);
  for (const v of vectors) {
    const n = l2Normalize(v);
    for (let i = 0; i < dims; i++) acc[i]! += n[i]!;
  }
  for (let i = 0; i < dims; i++) acc[i]! /= vectors.length;
  return l2Normalize(acc);
}
