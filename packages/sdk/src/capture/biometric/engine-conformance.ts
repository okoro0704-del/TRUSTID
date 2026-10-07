/**
 * Engine conformance vector: proof that an engine instance computes the
 * TrustID embedding space, checked on every device at warm-up.
 *
 * A fixed synthetic image (no person; deterministic arithmetic) and fixed
 * landmarks go through the real alignment (similarity transform, bilinear
 * sampling, RGB order, (x-127.5)/128 scaling, NCHW layout) and the real
 * model. The L2-normalized output must match ENGINE_CONFORMANCE_GOLDEN,
 * generated once on the reference engine (tests/engine-conformance.test.ts).
 *
 * The pattern is asymmetric in every axis and channel, so a BGR swap, a
 * mirrored or transposed crop, a different pixel scale, a different model or a
 * broken runtime all move the output far outside the tolerance. Any engine
 * implementation (web WASM today, a native runtime later) must pass this
 * before it produces an embedding the server will match.
 */
import { alignFaceToArcFace112, l2Normalize } from "./face-align.js";
import { ENGINE_CONFORMANCE_GOLDEN } from "./engine-conformance-golden.js";
import type { FaceLandmarks5 } from "./types.js";

/** Cosine similarity an engine must reach against the golden embedding. */
export const ENGINE_CONFORMANCE_MIN_COSINE = 0.9999;

const SIZE = 160;

/** Deterministic RGBA test card. Not a face and not derived from any person. */
export function conformanceImage(): ImageData {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4;
      data[o] = Math.round(127.5 + 110 * Math.sin(0.071 * x + 0.023 * y));
      data[o + 1] = Math.round(127.5 + 90 * Math.cos(0.043 * y - 0.017 * x) * Math.sin(0.011 * x * 0.7 + 1));
      data[o + 2] = (x * 3 + y * 5 + ((x * y) >> 4)) & 0xff;
      data[o + 3] = 255;
    }
  }
  return { data, width: SIZE, height: SIZE, colorSpace: "srgb" } as ImageData;
}

/** Rotated, off-centre 5-point set so the similarity transform is fully exercised. */
export const CONFORMANCE_LANDMARKS: FaceLandmarks5 = {
  leftEye: { x: 58.4, y: 66.1 },
  rightEye: { x: 103.2, y: 60.7 },
  nose: { x: 83.9, y: 88.3 },
  leftMouth: { x: 66.5, y: 115.0 },
  rightMouth: { x: 103.8, y: 110.2 },
};

/** The aligned [1,3,112,112] tensor the conformance check feeds the model. */
export function conformanceTensor(): Float32Array {
  return alignFaceToArcFace112(conformanceImage(), CONFORMANCE_LANDMARKS);
}

export type EngineConformanceResult = {
  ok: boolean;
  cosine: number;
  maxAbsDiff: number;
};

export function assessEngineConformance(
  rawOutput: ArrayLike<number>,
  golden: readonly number[] = ENGINE_CONFORMANCE_GOLDEN.embedding,
): EngineConformanceResult {
  if (rawOutput.length !== golden.length) return { ok: false, cosine: 0, maxAbsDiff: Infinity };
  const v = l2Normalize(rawOutput);
  let dot = 0;
  let maxAbsDiff = 0;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) return { ok: false, cosine: 0, maxAbsDiff: Infinity };
    dot += v[i]! * golden[i]!;
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(v[i]! - golden[i]!));
  }
  return { ok: dot >= ENGINE_CONFORMANCE_MIN_COSINE, cosine: dot, maxAbsDiff };
}
