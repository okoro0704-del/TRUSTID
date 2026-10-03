/**
 * InsightFace ArcFace recognizer ? w600k_mbf ONNX (512-D).
 * Input: NCHW float32 [1,3,112,112] normalized (x-127.5)/128.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ERROR_CODES,
} from "@trustid/shared";
import { biometricFail, biometricUnavailable } from "./errors.js";
import { l2Normalize } from "./face-align.js";
import {
  faceCaptureDiag,
  hashPrefix,
  sanitizeInitError,
} from "./face-capture-diag.js";
import { sha256Hex } from "./integrity.js";
import { ARCFACE_MBF_ARTIFACT } from "./model-manifest.js";
import {
  createOrtSession,
  getOrtModule,
  ORT_EXECUTION_PROVIDER,
  type OrtSession,
} from "./ort-runtime.js";
import { downloadModelBytes } from "./resumable-download.js";

export type EmbedderState = "IDLE" | "LOADING" | "READY" | "FAILED";

let sessionPromise: Promise<OrtSession> | null = null;
let modelBytesPromise: Promise<Uint8Array> | null = null;
let embedderState: EmbedderState = "IDLE";
let lastArcFaceInitError: string | null = null;
let lastExecutionProvider: string | null = null;

export function getLastArcFaceInitError(): string | null {
  return lastArcFaceInitError;
}

export function getLastArcFaceExecutionProvider(): string | null {
  return lastExecutionProvider;
}

export function getArcFaceEmbedderState(): EmbedderState {
  return embedderState;
}

// Range downloads are not reused by the HTTP cache, so a reload would fetch
// the model again. Keep the verified bytes in Cache Storage instead.
const MODEL_CACHE_PREFIX = "trustid-models-";
const MODEL_CACHE_NAME = `${MODEL_CACHE_PREFIX}${ARCFACE_MBF_ARTIFACT.sha256.slice(0, 16)}`;

async function readCachedModel(url: string): Promise<ArrayBuffer | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(MODEL_CACHE_NAME);
    const hit = await cache.match(url);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function storeCachedModel(url: string, buffer: ArrayBuffer): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(MODEL_CACHE_PREFIX) && k !== MODEL_CACHE_NAME)
        .map((k) => caches.delete(k)),
    );
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.put(
      url,
      new Response(buffer.slice(0), {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  } catch {
    /* storage full or blocked: the next load downloads again */
  }
}

async function dropCachedModel(url: string): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.delete(url);
  } catch {
    /* ignore */
  }
}

async function loadVerifiedModelBytes(url: string): Promise<Uint8Array> {
  faceCaptureDiag({
    stage: "arcface_model_fetch_start",
    component: "arcface",
    success: true,
    modelUrl: url,
  });

  let buffer: ArrayBuffer;
  let fromCache = false;
  try {
    const fetchStarted = performance.now();
    const cached = await readCachedModel(url);
    if (cached) {
      buffer = cached;
      fromCache = true;
    } else {
      buffer = await downloadModelBytes(url);
    }
    faceCaptureDiag({
      stage: "arcface_model_fetch_ok",
      component: "arcface",
      success: true,
      ms: Math.round(performance.now() - fetchStarted),
      modelUrl: url,
      imageWidth: buffer.byteLength,
    });

    faceCaptureDiag({
      stage: "arcface_integrity_start",
      component: "arcface",
      success: true,
      expectedHashPrefix: hashPrefix(ARCFACE_MBF_ARTIFACT.sha256),
    });
    let actual = await sha256Hex(buffer);
    if (
      fromCache &&
      actual.toLowerCase() !== ARCFACE_MBF_ARTIFACT.sha256.toLowerCase()
    ) {
      await dropCachedModel(url);
      buffer = await downloadModelBytes(url);
      fromCache = false;
      actual = await sha256Hex(buffer);
    }
    if (actual.toLowerCase() !== ARCFACE_MBF_ARTIFACT.sha256.toLowerCase()) {
      faceCaptureDiag({
        stage: "arcface_integrity_failed",
        component: "arcface",
        success: false,
        expectedHashPrefix: hashPrefix(ARCFACE_MBF_ARTIFACT.sha256),
        actualHashPrefix: hashPrefix(actual),
        errorCode: "INTEGRITY_MISMATCH",
      });
      throw biometricUnavailable(
        `ArcFace integrity failed (${url}): expected ${hashPrefix(ARCFACE_MBF_ARTIFACT.sha256)}? got ${hashPrefix(actual)}?`,
      );
    }
    faceCaptureDiag({
      stage: "arcface_integrity_ok",
      component: "arcface",
      success: true,
      expectedHashPrefix: hashPrefix(ARCFACE_MBF_ARTIFACT.sha256),
      actualHashPrefix: hashPrefix(actual),
    });
    if (!fromCache) await storeCachedModel(url, buffer);
    return new Uint8Array(buffer);
  } catch (err) {
    const msg = sanitizeInitError(err);
    lastArcFaceInitError = msg;
    faceCaptureDiag({
      stage: "arcface_model_fetch_or_integrity_failed",
      component: "arcface",
      success: false,
      modelUrl: url,
      errorMessage: msg,
    });
    throw biometricUnavailable(
      `ArcFace model missing or integrity failed (${url}). ${msg}`,
    );
  }
}

function getModelBytes(url: string): Promise<Uint8Array> {
  if (!modelBytesPromise) {
    modelBytesPromise = loadVerifiedModelBytes(url).catch((err) => {
      modelBytesPromise = null;
      throw err;
    });
  }
  return modelBytesPromise;
}

/**
 * Shared ArcFace session. Concurrent callers share one in-flight load. A
 * failed load clears only this session promise; the ORT runtime underneath is
 * owned by ort-runtime and is never re-initialized from here.
 */
export async function getArcFaceSession(
  modelBaseUrl = "/models/trustid",
): Promise<OrtSession> {
  if (!sessionPromise) {
    embedderState = "LOADING";
    sessionPromise = (async () => {
      const t0 = performance.now();
      faceCaptureDiag({
        stage: "arcface_session_start",
        component: "arcface",
        success: true,
        executionProvider: ORT_EXECUTION_PROVIDER,
      });
      const url = `${modelBaseUrl.replace(/\/$/, "")}/${ARCFACE_MBF_ARTIFACT.relativePath}`;
      const bytes = await getModelBytes(url);
      try {
        const session = await createOrtSession(bytes);
        modelBytesPromise = null;
        lastExecutionProvider = ORT_EXECUTION_PROVIDER;
        lastArcFaceInitError = null;
        embedderState = "READY";
        faceCaptureDiag({
          stage: "arcface_session_ok",
          component: "arcface",
          success: true,
          ms: Math.round(performance.now() - t0),
          executionProvider: ORT_EXECUTION_PROVIDER,
        });
        return session;
      } catch (err) {
        lastArcFaceInitError = sanitizeInitError(err);
        throw err;
      }
    })().catch((err) => {
      sessionPromise = null;
      embedderState = "FAILED";
      throw err;
    });
  }
  return sessionPromise;
}

export type ArcFaceEmbedResult = {
  vector: number[];
  modelName: string;
  modelVersion: number;
};

export async function embedAlignedFace112(
  nchw112: Float32Array,
  modelBaseUrl?: string,
): Promise<ArcFaceEmbedResult> {
  if (nchw112.length !== 1 * 3 * 112 * 112) {
    throw biometricFail(
      BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      "Aligned tensor must be [1,3,112,112]",
    );
  }

  const session = await getArcFaceSession(modelBaseUrl);
  const ort = await getOrtModule();
  const inputName = session.inputNames[0] ?? "input.1";
  const tensor = new ort.Tensor("float32", nchw112, [1, 3, 112, 112]);
  const outputs = await session.run({ [inputName]: tensor });
  const firstKey = session.outputNames[0] ?? Object.keys(outputs)[0];
  const out = firstKey ? outputs[firstKey] : undefined;
  if (!out?.data?.length) {
    throw biometricFail(
      BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      "ArcFace produced empty embedding",
    );
  }

  const raw = Array.from(out.data);
  if (raw.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    throw biometricFail(
      BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED,
      `Unexpected embedding size ${raw.length}; expected ${BIOMETRIC_AI_EMBEDDING_DIMS}`,
    );
  }

  nchw112.fill(0);

  return {
    vector: l2Normalize(raw),
    modelName: BIOMETRIC_AI_MODEL_NAME,
    modelVersion: BIOMETRIC_AI_MODEL_VERSION,
  };
}

export function isArcFaceReady(): boolean {
  return embedderState === "READY";
}

/** Test helper ? clear cached session so the next call reloads. */
export function resetArcFaceSessionForTests(): void {
  sessionPromise = null;
  modelBytesPromise = null;
  embedderState = "IDLE";
  lastArcFaceInitError = null;
  lastExecutionProvider = null;
}
