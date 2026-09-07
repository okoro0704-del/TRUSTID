/**
 * ArcFace align emits NCHW [1,3,112,112] planar RGB, not interleaved NHWC.
 */
import { describe, expect, it } from "vitest";
import { alignFaceToArcFace112 } from "../src/capture/biometric/face-align.js";
import type { FaceLandmarks5 } from "../src/capture/biometric/types.js";

function solidImage(r: number, g: number, b: number, size = 200): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: size, height: size, colorSpace: "srgb" } as ImageData;
}

const centeredLandmarks: FaceLandmarks5 = {
  leftEye: { x: 70, y: 80 },
  rightEye: { x: 130, y: 80 },
  nose: { x: 100, y: 110 },
  leftMouth: { x: 80, y: 140 },
  rightMouth: { x: 120, y: 140 },
};

describe("ArcFace tensor layout NCHW", () => {
  it("writes planar R then G then B channels (not RGBRGB interleaved)", () => {
    // Pure red source ? R channel ? (255-127.5)/128, G/B ? (0-127.5)/128
    const img = solidImage(255, 0, 0);
    const tensor = alignFaceToArcFace112(img, centeredLandmarks);
    expect(tensor.length).toBe(1 * 3 * 112 * 112);

    const plane = 112 * 112;
    const rMean =
      Array.from(tensor.subarray(0, plane)).reduce((a, b) => a + b, 0) / plane;
    const gMean =
      Array.from(tensor.subarray(plane, plane * 2)).reduce((a, b) => a + b, 0) /
      plane;
    const bMean =
      Array.from(tensor.subarray(plane * 2, plane * 3)).reduce(
        (a, b) => a + b,
        0,
      ) / plane;

    expect(rMean).toBeGreaterThan(0.8);
    expect(gMean).toBeLessThan(-0.8);
    expect(bMean).toBeLessThan(-0.8);

    // Interleaved NHWC would put R,G,B adjacent — first three samples would not
    // all be near the R-plane mean.
    expect(Math.abs(tensor[0]! - tensor[1]!)).toBeLessThan(0.05);
    expect(Math.abs(tensor[0]! - tensor[plane]!)).toBeGreaterThan(1.5);
  });
});
