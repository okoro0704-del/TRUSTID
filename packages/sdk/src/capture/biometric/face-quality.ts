import type { DetectedFace, FaceQualityResult } from "./types.js";

const MIN_FACE_RATIO = 0.12; // face width vs frame width
const MIN_DET_CONFIDENCE = 0.55;
const MAX_YAW_PROXY = 0.45; // eye-nose asymmetry proxy

/**
 * Geometric / photometric quality gate (not a DNN).
 * Separate from FACE_DETECTION and PAD.
 */
export function assessFaceQuality(
  imageData: ImageData,
  face: DetectedFace,
): FaceQualityResult {
  const reasons: string[] = [];
  let score = face.confidence;

  const { width: fw, height: fh } = imageData;
  const faceW = face.box.width;
  const faceH = face.box.height;
  const faceRatio = faceW / Math.max(1, fw);

  if (face.confidence < MIN_DET_CONFIDENCE) {
    reasons.push("low_detector_confidence");
    score *= 0.5;
  }
  if (faceRatio < MIN_FACE_RATIO || faceH < 64) {
    reasons.push("face_too_small");
    score *= 0.3;
  }

  // Pose proxy from eye-nose geometry
  const midEyeX = (face.landmarks.leftEye.x + face.landmarks.rightEye.x) / 2;
  const eyeDist = Math.hypot(
    face.landmarks.rightEye.x - face.landmarks.leftEye.x,
    face.landmarks.rightEye.y - face.landmarks.leftEye.y,
  );
  if (eyeDist > 1) {
    const yawProxy = Math.abs(face.landmarks.nose.x - midEyeX) / eyeDist;
    if (yawProxy > MAX_YAW_PROXY) {
      reasons.push("extreme_pose");
      score *= 0.4;
    }
  }

  // Exposure / blur proxy in face ROI
  const x0 = Math.max(0, Math.floor(face.box.xMin));
  const y0 = Math.max(0, Math.floor(face.box.yMin));
  const x1 = Math.min(fw, Math.ceil(face.box.xMin + face.box.width));
  const y1 = Math.min(fh, Math.ceil(face.box.yMin + face.box.height));
  let lumaSum = 0;
  let lumaSq = 0;
  let edge = 0;
  let count = 0;
  const { data } = imageData;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * fw + x) * 4;
      const l = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      lumaSum += l;
      lumaSq += l * l;
      if (x + 2 < x1) {
        const i2 = (y * fw + x + 2) * 4;
        const l2 =
          0.299 * (data[i2] ?? 0) +
          0.587 * (data[i2 + 1] ?? 0) +
          0.114 * (data[i2 + 2] ?? 0);
        edge += Math.abs(l - l2);
      }
      count++;
    }
  }
  if (count > 0) {
    const mean = lumaSum / count;
    const variance = Math.max(0, lumaSq / count - mean * mean);
    const edgeMean = edge / count;
    if (mean < 35 || mean > 230) {
      reasons.push("poor_exposure");
      score *= 0.4;
    }
    if (variance < 120 || edgeMean < 4) {
      reasons.push("blur_or_flat");
      score *= 0.35;
    }
  }

  const ok =
    reasons.length === 0 ||
    (!reasons.includes("face_too_small") &&
      !reasons.includes("extreme_pose") &&
      score >= 0.45);

  return { ok, score: Math.max(0, Math.min(1, score)), reasons };
}
