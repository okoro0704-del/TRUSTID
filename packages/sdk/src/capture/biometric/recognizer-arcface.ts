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
import { loadBiometricAsset } from "./asset-delivery.js";
import {
  assessEngineConformance,
  conformanceTensor,
  ENGINE_CONFORMANCE_MIN_COSINE,
} from "./engine-conformance.js";
import { ARCFACE_MBF_ARTIFACT, BIOMETRIC_RELEASE_ASSETS } from "./model-manifest.js";
import {
  createOrtSession,
  getOrtModule,
  ORT_EXECUTION_PROVIDER,
  type OrtSession,
} from "./ort-runtime.js";

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

async function loadVerifiedModelBytes(url: string): Promise<Uint8Array> {
  faceCaptureDiag({
    stage: "arcface_model_fetch_start",
    component: "arcface",
    success: true,
    modelUrl: url,
  });
  try {
    const fetchStarted = performance.now();
    // Cache, app bundle or network; resolves only with bytes whose SHA-256
    // equals ARCFACE_MBF_ARTIFACT.sha256.
    const loaded = await loadBiometricAsset(BIOMETRIC_RELEASE_ASSETS.arcface, { progressId: "arcface" });
    faceCaptureDiag({
      stage: "arcface_integrity_ok",
      component: "arcface",
      success: true,
      ms: Math.round(performance.now() - fetchStarted),
      modelUrl: loaded.url,
      imageWidth: loaded.bytes.byteLength,
      expectedHashPrefix: hashPrefix(ARCFACE_MBF_ARTIFACT.sha256),
      errorMessage: `source=${loaded.source}`,
    });
    return loaded.bytes;
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
    throw biometricUnavailable(`ArcFace model unavailable (${url}). ${msg}`);
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

/** One ArcFace inference at a time: the ORT session is shared page-wide. */
let embedQueue: Promise<unknown> = Promise.resolve();

export function embedAlignedFace112(
  nchw112: Float32Array,
  modelBaseUrl?: string,
): Promise<ArcFaceEmbedResult> {
  const run = embedQueue.then(() => embedAlignedFace112Now(nchw112, modelBaseUrl));
  embedQueue = run.catch(() => undefined);
  return run;
}

async function embedAlignedFace112Now(
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

/**
 * Run the loaded session once on the engine conformance input (a synthetic
 * test card through the real alignment) and require the output to match the
 * golden embedding. Proves this device computes the TrustID embedding space
 * before any face is embedded. Only the check result leaves this function.
 */
export function warmUpArcFace(modelBaseUrl?: string): Promise<{ dims: number; conformanceCosine: number }> {
  const run = embedQueue.then(async () => {
    const session = await getArcFaceSession(modelBaseUrl);
    const ort = await getOrtModule();
    const inputName = session.inputNames[0] ?? "input.1";
    const tensor = new ort.Tensor("float32", conformanceTensor(), [1, 3, 112, 112]);
    const outputs = await session.run({ [inputName]: tensor });
    const firstKey = session.outputNames[0] ?? Object.keys(outputs)[0];
    const data = firstKey ? outputs[firstKey]?.data : undefined;
    const dims = data?.length ?? 0;
    let finite = dims > 0;
    for (let i = 0; finite && i < dims; i++) {
      if (!Number.isFinite(data![i])) finite = false;
    }
    if (dims !== BIOMETRIC_AI_EMBEDDING_DIMS || !finite) {
      data?.fill?.(0);
      throw biometricUnavailable(
        `WARMUP_INVALID_OUTPUT: ArcFace warm-up returned ${dims} values${finite ? "" : " (non-finite)"}; expected ${BIOMETRIC_AI_EMBEDDING_DIMS}`,
      );
    }
    const conformance = assessEngineConformance(data!);
    data?.fill?.(0);
    faceCaptureDiag({
      stage: conformance.ok ? "arcface_conformance_ok" : "arcface_conformance_failed",
      component: "arcface",
      success: conformance.ok,
      errorMessage: `cosine=${conformance.cosine.toFixed(6)} maxAbsDiff=${conformance.maxAbsDiff.toExponential(2)}`,
    });
    if (!conformance.ok) {
      // Fail closed: embeddings from this engine would not be comparable to
      // enrolled templates, so it must not produce any.
      throw biometricUnavailable(
        `WARMUP_INVALID_OUTPUT: engine conformance failed (cosine ${conformance.cosine.toFixed(6)} < ${ENGINE_CONFORMANCE_MIN_COSINE})`,
      );
    }
    return { dims, conformanceCosine: conformance.cosine };
  });
  embedQueue = run.catch(() => undefined);
  return run;
}

export function isArcFaceReady(): boolean {
  return embedderState === "READY";
}

/** Test helper ? clear cached session so the next call reloads. */
export function resetArcFaceSessionForTests(): void {
  sessionPromise = null;
  modelBytesPromise = null;
  embedQueue = Promise.resolve();
  embedderState = "IDLE";
  lastArcFaceInitError = null;
  lastExecutionProvider = null;
}
