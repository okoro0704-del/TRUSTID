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

type OrtModule = {
  InferenceSession: {
    create: (
      uri: string | ArrayBuffer | Uint8Array,
      options?: Record<string, unknown>,
    ) => Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: number[],
  ) => { data: Float32Array; dims: number[] };
  env?: {
    wasm?: { wasmPaths?: string; numThreads?: number };
    webgpu?: { powerPreference?: string };
  };
};

type OrtSession = {
  inputNames: string[];
  outputNames: string[];
  run: (
    feeds: Record<string, unknown>,
  ) => Promise<Record<string, { data: Float32Array }>>;
};

let sessionPromise: Promise<OrtSession> | null = null;
let ortModule: OrtModule | null = null;
let lastArcFaceInitError: string | null = null;
let lastExecutionProvider: string | null = null;

export function getLastArcFaceInitError(): string | null {
  return lastArcFaceInitError;
}

export function getLastArcFaceExecutionProvider(): string | null {
  return lastExecutionProvider;
}

async function resolveOrtWasmPaths(): Promise<string> {
  const local = "/ort/";
  try {
    if (typeof fetch === "function") {
      const res = await fetch(`${local}ort-wasm-simd-threaded.mjs`, {
        method: "HEAD",
        credentials: "same-origin",
      });
      if (res.ok) {
        faceCaptureDiag({
          stage: "onnx_wasm_paths_local",
          component: "arcface",
          success: true,
          modelUrl: local,
        });
        return local;
      }
    }
  } catch (err) {
    faceCaptureDiag({
      stage: "onnx_wasm_paths_local_miss",
      component: "arcface",
      success: false,
      modelUrl: local,
      errorMessage: sanitizeInitError(err),
    });
  }
  const cdn = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
  faceCaptureDiag({
    stage: "onnx_wasm_paths_cdn_fallback",
    component: "arcface",
    success: true,
    modelUrl: cdn,
  });
  return cdn;
}

async function loadOrt(): Promise<OrtModule> {
  if (ortModule) return ortModule;
  const started = performance.now();
  faceCaptureDiag({
    stage: "onnx_runtime_import_start",
    component: "arcface",
    success: true,
  });
  try {
    // Types for onnxruntime-web package exports are incomplete under NodeNext.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const mod = await import("onnxruntime-web");
    ortModule = mod as unknown as OrtModule;
    if (ortModule.env?.wasm) {
      // Single-thread avoids Cross-Origin-Isolation requirements for threaded WASM.
      ortModule.env.wasm.numThreads = 1;
      ortModule.env.wasm.wasmPaths = await resolveOrtWasmPaths();
    }
    faceCaptureDiag({
      stage: "onnx_runtime_import_ok",
      component: "arcface",
      success: true,
      ms: Math.round(performance.now() - started),
      modelUrl: ortModule.env?.wasm?.wasmPaths,
    });
    return ortModule;
  } catch (err) {
    const msg = sanitizeInitError(err);
    lastArcFaceInitError = msg;
    faceCaptureDiag({
      stage: "onnx_runtime_import_failed",
      component: "arcface",
      success: false,
      ms: Math.round(performance.now() - started),
      errorMessage: msg,
    });
    throw biometricUnavailable(`onnxruntime-web unavailable: ${msg}`);
  }
}

async function createSessionWithProvider(
  ort: OrtModule,
  modelBytes: Uint8Array,
  providers: string[],
): Promise<OrtSession> {
  const started = performance.now();
  const label = providers.join("+");
  faceCaptureDiag({
    stage: "onnx_session_create_start",
    component: "arcface",
    success: true,
    executionProvider: label,
  });
  try {
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: providers,
    });
    lastExecutionProvider = label;
    faceCaptureDiag({
      stage: "onnx_session_create_ok",
      component: "arcface",
      success: true,
      ms: Math.round(performance.now() - started),
      executionProvider: label,
    });
    return session;
  } catch (err) {
    faceCaptureDiag({
      stage: "onnx_session_create_failed",
      component: "arcface",
      success: false,
      ms: Math.round(performance.now() - started),
      executionProvider: label,
      errorMessage: sanitizeInitError(err),
    });
    throw err;
  }
}

/** Cap hung WebGPU adapter / session attempts so WASM can still win within warm-up. */
const WEBGPU_ADAPTER_PROBE_MS = 2_000;
const WEBGPU_SESSION_CREATE_MS = 8_000;

type WebGpuProbeResult =
  | { ok: true }
  | { ok: false; reason: "api_missing" | "no_adapter" | "adapter_timeout" | "adapter_error"; detail?: string };

async function probeWebGpuAdapter(): Promise<WebGpuProbeResult> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const gpu = nav && "gpu" in nav
    ? (nav as Navigator & {
        gpu?: { requestAdapter: () => Promise<unknown> };
      }).gpu
    : undefined;
  if (!gpu?.requestAdapter) {
    return { ok: false, reason: "api_missing" };
  }

  let timedOut = false;
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, WEBGPU_ADAPTER_PROBE_MS);
      }),
    ]);
    if (timedOut) {
      return { ok: false, reason: "adapter_timeout" };
    }
    if (!adapter) {
      return { ok: false, reason: "no_adapter" };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "adapter_error",
      detail: sanitizeInitError(err),
    };
  }
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

export async function getArcFaceSession(
  modelBaseUrl = "/models/trustid",
): Promise<OrtSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const t0 = performance.now();
      faceCaptureDiag({
        stage: "arcface_session_start",
        component: "arcface",
        success: true,
      });

      const ort = await loadOrt();
      const url = `${modelBaseUrl.replace(/\/$/, "")}/${ARCFACE_MBF_ARTIFACT.relativePath}`;

      faceCaptureDiag({
        stage: "arcface_model_fetch_start",
        component: "arcface",
        success: true,
        modelUrl: url,
      });

      let buffer: ArrayBuffer;
      try {
        const fetchStarted = performance.now();
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) {
          throw new Error(
            `Failed to fetch model artifact (${res.status}): ${url}`,
          );
        }
        buffer = await res.arrayBuffer();
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
        const actual = await sha256Hex(buffer);
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

      const bytes = new Uint8Array(buffer);
      const probe = await probeWebGpuAdapter();

      if (probe.ok) {
        try {
          const session = await Promise.race([
            createSessionWithProvider(ort, bytes, ["webgpu"]),
            rejectAfter(
              WEBGPU_SESSION_CREATE_MS,
              `WebGPU InferenceSession.create timed out after ${WEBGPU_SESSION_CREATE_MS}ms`,
            ),
          ]);
          faceCaptureDiag({
            stage: "arcface_session_ok",
            component: "arcface",
            success: true,
            ms: Math.round(performance.now() - t0),
            executionProvider: "webgpu",
          });
          lastArcFaceInitError = null;
          return session;
        } catch (err) {
          faceCaptureDiag({
            stage: "gpu_session_failed_trying_wasm",
            component: "arcface",
            success: false,
            executionProvider: "webgpu",
            errorMessage: sanitizeInitError(err),
          });
        }
      } else {
        faceCaptureDiag({
          stage: "webgpu_unavailable_using_wasm",
          component: "arcface",
          success: true,
          executionProvider: "wasm",
          errorMessage: probe.detail
            ? `${probe.reason}: ${probe.detail}`
            : probe.reason,
        });
      }

      try {
        const session = await createSessionWithProvider(ort, bytes, ["wasm"]);
        faceCaptureDiag({
          stage: "arcface_session_ok",
          component: "arcface",
          success: true,
          ms: Math.round(performance.now() - t0),
          executionProvider: "wasm",
        });
        lastArcFaceInitError = null;
        return session;
      } catch (err) {
        const msg = sanitizeInitError(err);
        lastArcFaceInitError = msg;
        faceCaptureDiag({
          stage: "wasm_session_failed",
          component: "arcface",
          success: false,
          executionProvider: "wasm",
          errorMessage: msg,
        });
        throw biometricUnavailable(`ArcFace ONNX session failed: ${msg}`);
      }
    })().catch((err) => {
      sessionPromise = null;
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

  const ort = await loadOrt();
  const session = await getArcFaceSession(modelBaseUrl);
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
  return sessionPromise !== null;
}

/** Test helper ? clear cached session so the next call reloads. */
export function resetArcFaceSessionForTests(): void {
  sessionPromise = null;
  lastArcFaceInitError = null;
  lastExecutionProvider = null;
}
