/**
 * Heuristic face-presence gate ù rejects empty rooms / floors / blur frames
 * before any Trust ID enroll or login. Not a substitute for a DNN face detector,
 * but blocks the "camera spins then logs in with no face" failure mode.
 */
export type FacePresenceResult = {
  present: boolean;
  /** 0ù1 quality score once a face-like region is found */
  confidence: number;
  reason?: string;
};

function luma(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Approximate skin / face chroma without hard racial cutoffs ù soft gate + edges. */
function isFaceChroma(r: number, g: number, b: number): boolean {
  const y = luma(r, g, b);
  if (y < 40 || y > 230) return false;
  const rg = Math.abs(r - g);
  // Broad flesh-like band OR neutral mid-tone with some color (makeup / lighting)
  if (r >= 60 && g >= 40 && b >= 20 && r >= b - 10 && rg < 90 && r - b > -20) {
    return true;
  }
  return false;
}

export function detectFacePresence(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): FacePresenceResult {
  if (width < 48 || height < 48 || rgba.length < width * height * 4) {
    return { present: false, confidence: 0, reason: "frame_too_small" };
  }

  const cx0 = Math.floor(width * 0.22);
  const cx1 = Math.floor(width * 0.78);
  const cy0 = Math.floor(height * 0.12);
  const cy1 = Math.floor(height * 0.78);

  let globalLuma = 0;
  let globalSq = 0;
  let roiLuma = 0;
  let roiSq = 0;
  let roiCount = 0;
  let skinCount = 0;
  let edgeSum = 0;
  let edgeCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const yv = luma(r, g, b);
      globalLuma += yv;
      globalSq += yv * yv;

      const inRoi = x >= cx0 && x < cx1 && y >= cy0 && y < cy1;
      if (!inRoi) continue;

      roiCount++;
      roiLuma += yv;
      roiSq += yv * yv;
      if (isFaceChroma(r, g, b)) skinCount++;

      if (x + 1 < cx1 && y + 1 < cy1) {
        const i2 = (y * width + (x + 1)) * 4;
        const i3 = ((y + 1) * width + x) * 4;
        const y2 = luma(rgba[i2] ?? 0, rgba[i2 + 1] ?? 0, rgba[i2 + 2] ?? 0);
        const y3 = luma(rgba[i3] ?? 0, rgba[i3 + 1] ?? 0, rgba[i3 + 2] ?? 0);
        edgeSum += Math.abs(yv - y2) + Math.abs(yv - y3);
        edgeCount++;
      }
    }
  }

  const pixels = width * height;
  const mean = globalLuma / pixels;
  const variance = Math.max(0, globalSq / pixels - mean * mean);
  const roiMean = roiCount > 0 ? roiLuma / roiCount : 0;
  const roiVar = roiCount > 0 ? Math.max(0, roiSq / roiCount - roiMean * roiMean) : 0;
  const skinRatio = roiCount > 0 ? skinCount / roiCount : 0;
  const edgeMean = edgeCount > 0 ? edgeSum / edgeCount : 0;

  if (mean < 35 || mean > 225) {
    return { present: false, confidence: 0, reason: "bad_lighting" };
  }
  if (variance < 180) {
    return { present: false, confidence: 0, reason: "blank_frame" };
  }
  if (roiVar < 220) {
    return { present: false, confidence: 0, reason: "no_face_structure" };
  }
  if (edgeMean < 8) {
    return { present: false, confidence: 0, reason: "no_face_edges" };
  }
  // Need either skin-like chroma OR strong facial structure edges
  if (skinRatio < 0.08 && edgeMean < 14) {
    return { present: false, confidence: 0, reason: "no_face_region" };
  }

  const brightnessScore =
    1 - Math.min(1, Math.abs(roiMean - 120) / 120);
  const structureScore = Math.min(1, Math.sqrt(roiVar) / 55);
  const edgeScore = Math.min(1, edgeMean / 28);
  const skinScore = Math.min(1, skinRatio / 0.25);
  const confidence = Math.min(
    1,
    Math.max(
      0,
      brightnessScore * 0.2 +
        structureScore * 0.35 +
        edgeScore * 0.3 +
        skinScore * 0.15,
    ),
  );

  if (confidence < 0.42) {
    return { present: false, confidence, reason: "weak_face_signal" };
  }

  return { present: true, confidence };
}
