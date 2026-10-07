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

/**
 * Runtime builds the web app serves under versioned paths
 * (/ort/<version>/, /mediapipe/<version>/). Must equal the installed
 * onnxruntime-web and @mediapipe/tasks-vision versions (checked by tests).
 */
export const ORT_WEB_VERSION = "1.21.0";
export const MEDIAPIPE_TASKS_VISION_VERSION = "0.10.18";
export const MEDIAPIPE_WASM_BASE = `/mediapipe/${MEDIAPIPE_TASKS_VISION_VERSION}`;

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

/**
 * Every binary the biometric engine loads, pinned by SHA-256 of its decoded
 * bytes. The JS bundle, these runtimes and these models are one release unit:
 * a bundle only ever asks for the exact bytes listed here, so new JS can never
 * run an old WASM or a different model.
 *
 * Delivered at content-addressed, immutable paths
 *   /biometric/<sha256[0..16]>/<file>      decoded bytes (native bundle, fallback)
 *   /biometric/<sha256[0..16]>/<file>.gz.bin   gzip, fetched in resumable ranges
 *     (".bin", not ".gz": static servers and CDNs attach Content-Encoding to
 *     .gz files, which breaks Range requests and hides the compressed bytes)
 * produced by scripts/stage-biometric-assets.mjs.
 */
export type BiometricReleaseAssetId =
  | "ort-wasm"
  | "ort-loader"
  | "mediapipe-loader-simd"
  | "mediapipe-loader-nosimd"
  | "mediapipe-wasm-simd"
  | "mediapipe-wasm-nosimd"
  | "face-landmarker"
  | "arcface";

export type BiometricReleaseAsset = {
  id: BiometricReleaseAssetId;
  file: string;
  sha256: string;
  bytes: number;
  contentType: string;
  component: "runtime" | "detector" | "embedder";
  /** Package version (runtimes) or model id this file belongs to. */
  version: string;
};

export const BIOMETRIC_RELEASE_ASSETS: Record<BiometricReleaseAssetId, BiometricReleaseAsset> = {
  "ort-wasm": {
    id: "ort-wasm",
    file: "ort-wasm-simd-threaded.wasm",
    sha256: "06b3f98e5aa2fffec1e3ac57a48bf1073828c6624e14d210750bc596c2e35d65",
    bytes: 12_666_427,
    contentType: "application/wasm",
    component: "runtime",
    version: `onnxruntime-web@${ORT_WEB_VERSION}`,
  },
  "ort-loader": {
    id: "ort-loader",
    file: "ort-wasm-simd-threaded.mjs",
    sha256: "e9ba2350c370278fc90108f1514fb9ce6a4051341ab977b5b0dca7eca9e78dfa",
    bytes: 26_583,
    contentType: "text/javascript",
    component: "runtime",
    version: `onnxruntime-web@${ORT_WEB_VERSION}`,
  },
  "mediapipe-loader-simd": {
    id: "mediapipe-loader-simd",
    file: "vision_wasm_internal.js",
    sha256: "2b120e1c7272905719f7893e5f09e033ead468b46b510e6b490d93e3d94ec69c",
    bytes: 203_819,
    contentType: "text/javascript",
    component: "detector",
    version: `@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}`,
  },
  "mediapipe-loader-nosimd": {
    id: "mediapipe-loader-nosimd",
    file: "vision_wasm_nosimd_internal.js",
    sha256: "d206ba4e27c42a5863b4001c6d9366345f4507979cd6efd087a149ef7781ccd3",
    bytes: 203_672,
    contentType: "text/javascript",
    component: "detector",
    version: `@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}`,
  },
  "mediapipe-wasm-simd": {
    id: "mediapipe-wasm-simd",
    file: "vision_wasm_internal.wasm",
    sha256: "35d67ac01df034a04a38cb0533d6438595bcc65c485aed61dd47c86c6c3839cd",
    bytes: 9_502_124,
    contentType: "application/wasm",
    component: "detector",
    version: `@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}`,
  },
  "mediapipe-wasm-nosimd": {
    id: "mediapipe-wasm-nosimd",
    file: "vision_wasm_nosimd_internal.wasm",
    sha256: "17c2bff095305fcae98faa0817cbf72f13df9baf76f2067992a8624ef54d18cb",
    bytes: 9_376_240,
    contentType: "application/wasm",
    component: "detector",
    version: `@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}`,
  },
  "face-landmarker": {
    id: "face-landmarker",
    file: MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.relativePath,
    sha256: MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.sha256,
    bytes: 3_758_596,
    contentType: "application/octet-stream",
    component: "detector",
    version: MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.id,
  },
  arcface: {
    id: "arcface",
    file: ARCFACE_MBF_ARTIFACT.relativePath,
    sha256: ARCFACE_MBF_ARTIFACT.sha256,
    bytes: 13_616_099,
    contentType: "application/octet-stream",
    component: "embedder",
    version: ARCFACE_MBF_ARTIFACT.id,
  },
};

/** Suffix of the gzip copy used for network delivery. */
export const BIOMETRIC_GZIP_SUFFIX = ".gz.bin";

/** Directory segment of an asset's immutable URL. */
export function biometricAssetDir(asset: Pick<BiometricReleaseAsset, "sha256">): string {
  return asset.sha256.slice(0, 16);
}

/** Path of an asset relative to the asset base, e.g. "biometric/06b3f98e5aa2fffe/ort-wasm-simd-threaded.wasm". */
export function biometricAssetPath(asset: BiometricReleaseAsset, gzip = false): string {
  return `biometric/${biometricAssetDir(asset)}/${asset.file}${gzip ? BIOMETRIC_GZIP_SUFFIX : ""}`;
}

/**
 * The engine release identity. `releaseId` changes whenever any runtime or
 * model byte changes, so it names exactly which bytes produced an embedding.
 * The embedding space itself is identified to the server by
 * BIOMETRIC_AI_MODEL_NAME / BIOMETRIC_AI_MODEL_VERSION plus the detector,
 * alignment and preprocessing versions already sent with every payload.
 */
export const BIOMETRIC_ENGINE_RELEASE = {
  engineVersion: 2,
  releaseId: [
    "e2",
    ...Object.values(BIOMETRIC_RELEASE_ASSETS).map((a) => a.sha256.slice(0, 6)),
  ].join("-"),
  runtimes: {
    onnxruntimeWeb: ORT_WEB_VERSION,
    mediapipeTasksVision: MEDIAPIPE_TASKS_VISION_VERSION,
  },
  embedder: {
    modelName: TRUSTID_MODEL_MANIFEST.modelName,
    modelVersion: TRUSTID_MODEL_MANIFEST.modelVersion,
    sha256: ARCFACE_MBF_ARTIFACT.sha256,
    dimensions: TRUSTID_MODEL_MANIFEST.embeddingDimensions,
    inputShape: [1, 3, 112, 112] as const,
    layout: "NCHW",
    colorOrder: "RGB",
    normalize: TRUSTID_MODEL_MANIFEST.normalize,
    outputNormalization: "l2",
  },
  detector: {
    id: MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.id,
    sha256: MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.sha256,
  },
  /**
   * Where inference runs on each platform. Native shells deliver the same
   * verified bytes from the installed app and run the same engine, so every
   * platform shares one embedding space by construction.
   */
  platforms: {
    web: { delivery: "network-cached", inference: "wasm" },
    android: { delivery: "app-bundle", inference: "wasm", minNativeAssetApi: 1 },
    ios: { delivery: "app-bundle", inference: "wasm", minNativeAssetApi: 1 },
  },
} as const;

export type BiometricEngineRelease = typeof BIOMETRIC_ENGINE_RELEASE;
