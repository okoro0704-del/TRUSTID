/**
 * InsightFace ArcFace recognizer ù w600k_mbf ONNX (512-D).
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
import { fetchVerifiedArtifact } from "./integrity.js";
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
  env?: { wasm?: { wasmPaths?: string }; webgpu?: { powerPreference?: string } };
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

async function loadOrt(): Promise<OrtModule> {
  if (ortModule) return ortModule;
  try {
    // Types for onnxruntime-web package exports are incomplete under NodeNext.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const mod = await import("onnxruntime-web");
    ortModule = mod as unknown as OrtModule;
    // Prefer WebGPU when available, else WASM
    if (ortModule.env?.wasm) {
      ortModule.env.wasm.wasmPaths =
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
    }
    return ortModule;
  } catch (err) {
    throw biometricUnavailable(
      `onnxruntime-web unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getArcFaceSession(
  modelBaseUrl = "/models/trustid",
): Promise<OrtSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      const url = `${modelBaseUrl.replace(/\/$/, "")}/${ARCFACE_MBF_ARTIFACT.relativePath}`;
      let buffer: ArrayBuffer;
      try {
        buffer = await fetchVerifiedArtifact(url, ARCFACE_MBF_ARTIFACT.sha256);
      } catch (err) {
        throw biometricUnavailable(
          `ArcFace model missing or integrity failed (${url}). Run scripts/fetch-biometric-models.mjs. ${err instanceof Error ? err.message : ""}`,
        );
      }

      const providers: string[] = [];
      if (typeof navigator !== "undefined" && "gpu" in navigator) {
        providers.push("webgpu");
      }
      providers.push("wasm");

      try {
        return await ort.InferenceSession.create(new Uint8Array(buffer), {
          executionProviders: providers,
        });
      } catch {
        return ort.InferenceSession.create(new Uint8Array(buffer), {
          executionProviders: ["wasm"],
        });
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

  // Zero sensitive intermediate (best-effort)
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
