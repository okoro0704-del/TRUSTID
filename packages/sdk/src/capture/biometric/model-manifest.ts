/**
 * Versioned biometric model manifest with SHA-256 integrity.
 * Models are served from /models/trustid/ (web) after scripts/fetch-biometric-models.mjs.
 */
export type ModelArtifact = {
  id: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  purpose: "recognition" | "detector" | "pad" | "wasm" | "mediapipe_task";
  license: string;
  source: string;
};

/**
 * InsightFace buffalo_s ArcFace MobileFaceNet (w600k_mbf).
 * SHA256 from Hugging Face deepghs/insightface.
 */
export const ARCFACE_MBF_ARTIFACT: ModelArtifact = {
  id: "insightface_w600k_mbf",
  relativePath: "w600k_mbf.onnx",
  sha256:
    "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f",
  bytes: 13_600_000,
  purpose: "recognition",
  license: "InsightFace model weights (see MODEL_CARD.md)",
  source:
    "https://huggingface.co/deepghs/insightface/resolve/main/buffalo_s/w600k_mbf.onnx",
};

/** MediaPipe Face Landmarker task (Google, Apache-2.0) */
export const MEDIAPIPE_FACE_LANDMARKER_ARTIFACT: ModelArtifact = {
  id: "mediapipe_face_landmarker",
  relativePath: "face_landmarker.task",
  sha256:
    "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
  bytes: 3_753_000,
  purpose: "mediapipe_task",
  license: "Apache-2.0 (MediaPipe)",
  source:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

export const TRUSTID_MODEL_MANIFEST = {
  recognition: ARCFACE_MBF_ARTIFACT,
  detectorTask: MEDIAPIPE_FACE_LANDMARKER_ARTIFACT,
  modelName: "insightface_arcface_w600k_mbf_v1",
  modelVersion: 1,
  embeddingDimensions: 512,
  inputResolution: [112, 112] as const,
  normalize: { mean: 127.5, std: 128.0 },
  similarityMetric: "cosine_distance",
} as const;

export type TrustIdModelManifest = typeof TRUSTID_MODEL_MANIFEST;
