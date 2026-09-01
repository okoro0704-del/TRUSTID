import { BIOMETRIC_FACE_EMBEDDING_DIMS } from "@trustid/shared";

export type FaceVectorResult = {
  embedding: number[];
  confidence: number;
};

/**
 * Lightweight in-memory face vectorization from RGBA pixel buffer.
 * No disk I/O — frame data is consumed and discarded by the caller.
 */
export function vectorizeFaceFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  dims = BIOMETRIC_FACE_EMBEDDING_DIMS,
): FaceVectorResult {
  if (width <= 0 || height <= 0 || rgba.length === 0) {
    return { embedding: zeroVector(dims), confidence: 0 };
  }

  const grid = Math.ceil(Math.sqrt(dims));
  const cellW = width / grid;
  const cellH = height / grid;
  const v = new Array<number>(dims).fill(0);

  let lumaSum = 0;
  let lumaSq = 0;
  let centerLumaSum = 0;
  let centerCount = 0;
  const cx0 = width * 0.25;
  const cx1 = width * 0.75;
  const cy0 = height * 0.2;
  const cy1 = height * 0.85;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      lumaSum += luma;
      lumaSq += luma * luma;

      const gx = Math.min(grid - 1, Math.floor(x / cellW));
      const gy = Math.min(grid - 1, Math.floor(y / cellH));
      const idx = gy * grid + gx;
      if (idx < dims) {
        v[idx] = (v[idx] ?? 0) + luma / 255;
      }

      if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) {
        centerLumaSum += luma;
        centerCount++;
      }
    }
  }

  const pixels = width * height;
  const meanLuma = lumaSum / pixels;
  const variance = Math.max(0, lumaSq / pixels - meanLuma * meanLuma);
  const centerMean = centerCount > 0 ? centerLumaSum / centerCount : meanLuma;

  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const embedding = norm > 0 ? v.map((x) => x / norm) : zeroVector(dims);

  const brightnessScore =
    meanLuma >= 40 && meanLuma <= 220
      ? 1 - Math.abs(meanLuma - 128) / 128
      : 0;
  const varianceScore = Math.min(1, Math.sqrt(variance) / 64);
  const centerScore =
    centerMean >= 35 && centerMean <= 225
      ? Math.min(1, Math.sqrt(variance) / 48)
      : 0;

  const confidence = Math.min(
    1,
    Math.max(0, brightnessScore * 0.35 + varianceScore * 0.35 + centerScore * 0.3),
  );

  return { embedding, confidence };
}

function zeroVector(dims: number): number[] {
  return Array.from({ length: dims }, () => 0);
}
