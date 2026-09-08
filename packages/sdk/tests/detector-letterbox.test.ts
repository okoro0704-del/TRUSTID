/**
 * Unit tests for MediaPipe square letterbox mapping (no MediaPipe runtime).
 */
import { describe, expect, it } from "vitest";
import {
  letterboxImageDataToSquareData,
  mapSquareNormToSourcePixels,
  squareLetterboxGeometry,
} from "../src/capture/biometric/detector-mediapipe.js";
import { summarizeImageDataSignal } from "../src/capture/biometric/face-capture-diag.js";

function makeImageData(width: number, height: number, fill = 40): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("MediaPipe square letterbox helpers", () => {
  it("computes 640x480 letterbox geometry onto a 640 square", () => {
    const g = squareLetterboxGeometry(640, 480);
    expect(g.side).toBe(640);
    expect(g.offsetX).toBe(0);
    expect(g.offsetY).toBe(80);
  });

  it("letterboxes ImageData onto a square buffer without Canvas 2D", () => {
    const src = makeImageData(640, 480, 90);
    const { square, side, offsetX, offsetY } =
      letterboxImageDataToSquareData(src);
    expect(side).toBe(640);
    expect(square.width).toBe(640);
    expect(square.height).toBe(640);
    expect(offsetX).toBe(0);
    expect(offsetY).toBe(80);
    const cx = 320;
    const cy = 240 + offsetY;
    const i = (cy * side + cx) * 4;
    expect(square.data[i]).toBe(90);
    expect(square.data[0]).toBe(0);
  });

  it("maps square-normalized landmarks back into the source frame", () => {
    const mapped = mapSquareNormToSourcePixels(
      [{ x: 0.5, y: 0.5 }],
      640,
      480,
      640,
      0,
      80,
    );
    expect(mapped[0]!.x).toBeCloseTo(0.5, 5);
    expect(mapped[0]!.y).toBeCloseTo(0.5, 5);
  });

  it("summarizeImageDataSignal reports non-zero without exposing pixels", () => {
    const blank = makeImageData(8, 8, 0);
    const lit = makeImageData(8, 8, 128);
    expect(summarizeImageDataSignal(blank).hasNonZeroPixels).toBe(false);
    expect(summarizeImageDataSignal(lit).hasNonZeroPixels).toBe(true);
    expect(summarizeImageDataSignal(lit).meanLumaApprox).toBeGreaterThan(0);
  });
});
