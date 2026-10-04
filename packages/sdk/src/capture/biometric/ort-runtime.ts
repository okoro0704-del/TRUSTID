/**
 * Page-level owner of the onnxruntime-web WebAssembly runtime.
 *
 * ORT initializes its WASM module once per page and never recovers from a
 * failed or overlapping init: `initializeWebAssemblyAndOrtRuntime` throws
 * "multiple calls to 'initWasm()' detected." while an init is in flight and
 * "previous call ... failed" afterwards, and onnxruntime-common caches that
 * error per backend name ("no available backend found. ERR: [wasm] ...").
 * Every backend name ("webgpu", "webnn", "cpu", "wasm") in the default bundle
 * shares that one runtime, so starting a second provider while the first is
 * still initializing poisons the page.
 *
 * Rules enforced here:
 * - only the WASM-only ORT build is loaded and only the "wasm" provider is used;
 * - runtime assets (loader .mjs + .wasm binary) are fetched and checked here,
 *   with retries, before ORT is allowed to initialize;
 * - ORT's own runtime init is entered at most once per page; concurrent
 *   callers share it, and a failed init is a page-level failure that needs a
 *   reload rather than another init call.
 *
 * Diagnostics are metadata only. Nothing here sees frames or embeddings.
 */
import { reportAssetProgress } from "./asset-progress.js";
import {
  BIOMETRIC_ASSET_KEYS,
  readBiometricAsset,
  storeBiometricAsset,
} from "./biometric-asset-cache.js";
import { biometricUnavailable } from "./errors.js";
import { faceCaptureDiag, sanitizeInitError } from "./face-capture-diag.js";
import { BiometricAssetError, downloadModelBytes } from "./resumable-download.js";

export type OrtTensor = { data: Float32Array; dims: number[] };

export type OrtSession = {
  inputNames: string[];
  outputNames: string[];
  run: (
    feeds: Record<string, unknown>,
  ) => Promise<Record<string, { data: Float32Array }>>;
  release?: () => Promise<void>;
};

export type OrtModule = {
  InferenceSession: {
    create: (
      model: Uint8Array,
      options?: Record<string, unknown>,
    ) => Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  env: {
    versions?: { common?: string; web?: string };
    wasm: {
      numThreads?: number;
      proxy?: boolean;
      wasmPaths?: string | { mjs?: string; wasm?: string };
      wasmBinary?: ArrayBufferLike | Uint8Array;
    };
  };
};

export const ORT_EXECUTION_PROVIDER = "wasm" as const;
export const ORT_WASM_MODULE_FILE = "ort-wasm-simd-threaded.mjs";
export const ORT_WASM_BINARY_FILE = "ort-wasm-simd-threaded.wasm";

export const ORT_RUNTIME_ERROR_CODES = {
  IMPORT_FAILED: "BIOMETRIC_RUNTIME_IMPORT_FAILED",
  ASSETS_UNAVAILABLE: "BIOMETRIC_RUNTIME_ASSETS_UNAVAILABLE",
  INIT_FAILED: "BIOMETRIC_RUNTIME_FAILED",
  SESSION_FAILED: "BIOMETRIC_SESSION_FAILED",
  PROBE_FAILED: "BIOMETRIC_RUNTIME_PROBE_FAILED",
} as const;

export type OrtRuntimeErrorCode =
  (typeof ORT_RUNTIME_ERROR_CODES)[keyof typeof ORT_RUNTIME_ERROR_CODES];

export type OrtRuntimeState = "IDLE" | "LOADING" | "READY" | "FAILED";

export type OrtRuntimeStatus = {
  state: OrtRuntimeState;
  ortVersion: string | null;
  executionProvider: typeof ORT_EXECUTION_PROVIDER;
  numThreads: 1;
  proxy: false;
  crossOriginIsolated: boolean;
  /** Times ORT was allowed to enter its own runtime init. Must stay <= 1. */
  runtimeInitAttempts: number;
  failureStage: string | null;
  failureCode: OrtRuntimeErrorCode | null;
  /** True once ORT's runtime init failed: only a page reload can recover. */
  requiresReload: boolean;
};

type RuntimeHooks = {
  importOrt: () => Promise<OrtModule>;
  fetchBinary: (url: string) => Promise<ArrayBuffer>;
  preloadModule: (url: string) => Promise<unknown>;
  origin: () => string;
};

const defaultHooks: RuntimeHooks = {
  importOrt: async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- package exports carry no types under NodeNext
    const mod = await import("onnxruntime-web/wasm");
    return mod as unknown as OrtModule;
  },
  fetchBinary: (url) =>
    downloadModelBytes(url, fetch, undefined, {
      onProgress: (loaded, total) =>
        reportAssetProgress("ort-wasm", { url, loaded, total, fromCache: false }),
    }),
  preloadModule: (url) => import(/* @vite-ignore */ url),
  origin: () =>
    typeof location !== "undefined" && location.origin
      ? location.origin
      : "http://localhost",
};

let hooks: RuntimeHooks = defaultHooks;

let modulePromise: Promise<OrtModule> | null = null;
let assetsPromise: Promise<void> | null = null;
let assetsReady = false;
let runtimeInitPromise: Promise<OrtSession> | null = null;
let runtimeReady = false;
let runtimeFailed = false;
let runtimeInitAttempts = 0;
let ortVersion: string | null = null;
let failureStage: string | null = null;
let failureCode: OrtRuntimeErrorCode | null = null;
let state: OrtRuntimeState = "IDLE";

const ASSET_ATTEMPTS = 3;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const MIN_WASM_BYTES = 1024 * 1024;

const RUNTIME_INIT_ERROR =
  /no available backend found|initWasm|initializeWebAssembly|WebAssembly backend initializing failed|SIMD is not supported/i;

function runtimeError(code: OrtRuntimeErrorCode, stage: string, err?: unknown) {
  failureCode = code;
  failureStage = stage;
  faceCaptureDiag({
    stage: `ort_runtime_${stage}_failed`,
    component: "ort-runtime",
    success: false,
    errorCode: code,
    errorMessage: err === undefined ? undefined : sanitizeInitError(err),
    executionProvider: ORT_EXECUTION_PROVIDER,
  });
  const category = err instanceof BiometricAssetError ? ` [${err.category}]` : "";
  return biometricUnavailable(`${code}: biometric runtime unavailable (${stage})${category}`);
}

function readCrossOriginIsolated(): boolean {
  return typeof self !== "undefined" && Boolean(self.crossOriginIsolated);
}

function configureEnv(ort: OrtModule): void {
  // Single thread needs no SharedArrayBuffer / cross-origin isolation, and
  // no proxy worker keeps init on this thread where it can be observed.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ortVersion = ort.env.versions?.web ?? null;
}

export function getOrtModule(): Promise<OrtModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const started = performance.now();
      const ort = await hooks.importOrt();
      configureEnv(ort);
      faceCaptureDiag({
        stage: "ort_runtime_import_ok",
        component: "ort-runtime",
        success: true,
        ms: Math.round(performance.now() - started),
        executionProvider: ORT_EXECUTION_PROVIDER,
        errorMessage: `ort=${ortVersion ?? "unknown"} coi=${readCrossOriginIsolated()}`,
      });
      return ort;
    })().catch((err) => {
      modulePromise = null;
      throw runtimeError(ORT_RUNTIME_ERROR_CODES.IMPORT_FAILED, "import", err);
    });
  }
  return modulePromise;
}

/** Same-origin, version-scoped path so a new ORT build never meets stale assets. */
export function ortAssetBase(version: string, origin = hooks.origin()): string {
  return `${origin.replace(/\/$/, "")}/ort/${version}/`;
}

function isWasmBinary(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= MIN_WASM_BYTES &&
    WASM_MAGIC.every((b, i) => bytes[i] === b)
  );
}

async function loadWasmBinary(url: string, version: string): Promise<Uint8Array> {
  const cacheKey = BIOMETRIC_ASSET_KEYS.ortWasm(version);
  const cached = await readBiometricAsset(cacheKey);
  if (cached && isWasmBinary(cached)) {
    reportAssetProgress("ort-wasm", {
      url,
      loaded: cached.byteLength,
      total: cached.byteLength,
      fromCache: true,
    });
    return cached;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < ASSET_ATTEMPTS; attempt++) {
    try {
      const bytes = new Uint8Array(await hooks.fetchBinary(url));
      if (!isWasmBinary(bytes)) {
        // The SPA fallback answers missing files with index.html (HTTP 200).
        throw new BiometricAssetError(
          "ASSET_NOT_BINARY",
          url,
          `not a WebAssembly binary (${bytes.byteLength} bytes)`,
        );
      }
      await storeBiometricAsset(cacheKey, bytes, "application/wasm");
      return bytes;
    } catch (err) {
      lastError = err;
      if (
        err instanceof BiometricAssetError &&
        (err.category === "ASSET_MISSING" || err.category === "ASSET_NOT_BINARY")
      ) {
        break;
      }
    }
  }
  throw lastError;
}

async function preloadWasmModule(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ASSET_ATTEMPTS; attempt++) {
    // A failed module fetch may be remembered for that exact URL, so each
    // retry uses a distinct one; ORT is then pointed at the URL that loaded.
    const candidate = attempt === 0 ? url : `${url}?attempt=${attempt}`;
    try {
      const mod = (await hooks.preloadModule(candidate)) as { default?: unknown };
      if (typeof mod?.default !== "function") {
        throw new Error("ORT loader module has no factory export");
      }
      return candidate;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function prepareRuntimeAssets(ort: OrtModule): Promise<void> {
  if (assetsReady) return;
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const started = performance.now();
      if (!ortVersion) throw new Error("onnxruntime-web version unknown");
      const base = ortAssetBase(ortVersion);
      const binary = await loadWasmBinary(`${base}${ORT_WASM_BINARY_FILE}`, ortVersion);
      const mjs = await preloadWasmModule(`${base}${ORT_WASM_MODULE_FILE}`);
      ort.env.wasm.wasmPaths = { mjs };
      ort.env.wasm.wasmBinary = binary;
      assetsReady = true;
      faceCaptureDiag({
        stage: "ort_runtime_assets_ok",
        component: "ort-runtime",
        success: true,
        ms: Math.round(performance.now() - started),
        modelUrl: base,
        imageWidth: binary.byteLength,
      });
    })().catch((err) => {
      assetsPromise = null;
      throw runtimeError(ORT_RUNTIME_ERROR_CODES.ASSETS_UNAVAILABLE, "assets", err);
    });
  }
  return assetsPromise;
}

async function createSession(ort: OrtModule, model: Uint8Array): Promise<OrtSession> {
  return ort.InferenceSession.create(model, {
    executionProviders: [ORT_EXECUTION_PROVIDER],
  });
}

function markRuntimeReady(ort: OrtModule): void {
  runtimeReady = true;
  state = "READY";
  ort.env.wasm.wasmBinary = undefined;
}

/**
 * The only way TrustID creates an ORT session. The first call lets ORT
 * initialize its runtime; callers arriving meanwhile wait for that to settle
 * instead of starting another init.
 */
export async function createOrtSession(model: Uint8Array): Promise<OrtSession> {
  if (runtimeFailed) {
    throw biometricUnavailable(
      `${ORT_RUNTIME_ERROR_CODES.INIT_FAILED}: biometric runtime unavailable (reload required)`,
    );
  }
  if (state === "IDLE") state = "LOADING";
  let ort: OrtModule;
  try {
    ort = await getOrtModule();
    await prepareRuntimeAssets(ort);
  } catch (err) {
    if (!runtimeReady) state = "IDLE";
    throw err;
  }

  if (runtimeReady) {
    try {
      return await createSession(ort, model);
    } catch (err) {
      throw runtimeError(ORT_RUNTIME_ERROR_CODES.SESSION_FAILED, "session", err);
    }
  }

  if (runtimeInitPromise) {
    await runtimeInitPromise.catch(() => undefined);
    return createOrtSession(model);
  }

  runtimeInitAttempts += 1;
  const started = performance.now();
  const init = createSession(ort, model).then(
    (session) => {
      markRuntimeReady(ort);
      failureCode = null;
      failureStage = null;
      faceCaptureDiag({
        stage: "ort_runtime_ready",
        component: "ort-runtime",
        success: true,
        ms: Math.round(performance.now() - started),
        executionProvider: ORT_EXECUTION_PROVIDER,
      });
      return session;
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (RUNTIME_INIT_ERROR.test(msg)) {
        // ORT keeps this failure for the life of the page.
        runtimeFailed = true;
        state = "FAILED";
        throw runtimeError(ORT_RUNTIME_ERROR_CODES.INIT_FAILED, "init", err);
      }
      // ORT resolves (initializes) the backend before it parses the model, so
      // any other failure leaves an initialized runtime and a failed session.
      markRuntimeReady(ort);
      throw runtimeError(ORT_RUNTIME_ERROR_CODES.SESSION_FAILED, "session", err);
    },
  );
  runtimeInitPromise = init;
  try {
    return await init;
  } finally {
    if (runtimeInitPromise === init) runtimeInitPromise = null;
  }
}

/**
 * 63-byte ONNX graph `y = Identity(x)`, x: float32[1], opset 13. Lets the
 * runtime initialize and prove one inference before any model download ends.
 */
export const ORT_RUNTIME_PROBE_MODEL = Uint8Array.from([
  8, 7, 58, 55, 10, 16, 10, 1, 120, 18, 1, 121, 34, 8, 73, 100, 101, 110, 116, 105,
  116, 121, 18, 1, 112, 90, 15, 10, 1, 120, 18, 10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1,
  98, 15, 10, 1, 121, 18, 10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1, 66, 2, 16, 13,
]);

let runtimeProbePromise: Promise<void> | null = null;

/**
 * Initialize the page's ORT runtime and run one probe inference. Idempotent:
 * concurrent and repeated callers share one probe, and ORT's own init still
 * happens at most once (inside createOrtSession).
 */
export function initOrtRuntime(): Promise<void> {
  if (!runtimeProbePromise) {
    runtimeProbePromise = (async () => {
      const session = await createOrtSession(ORT_RUNTIME_PROBE_MODEL);
      try {
        const ort = await getOrtModule();
        const input = session.inputNames[0] ?? "x";
        const output = session.outputNames[0] ?? "y";
        const out = await session.run({
          [input]: new ort.Tensor("float32", Float32Array.from([0.5]), [1]),
        });
        const y = out[output]?.data;
        if (!y || y.length !== 1 || y[0] !== 0.5) {
          throw new Error("probe inference returned an unexpected result");
        }
      } catch (err) {
        throw runtimeError(ORT_RUNTIME_ERROR_CODES.PROBE_FAILED, "probe", err);
      } finally {
        await session.release?.().catch(() => undefined);
      }
    })().catch((err) => {
      runtimeProbePromise = null;
      throw err;
    });
  }
  return runtimeProbePromise;
}

export function getOrtRuntimeStatus(): OrtRuntimeStatus {
  return {
    state,
    ortVersion,
    executionProvider: ORT_EXECUTION_PROVIDER,
    numThreads: 1,
    proxy: false,
    crossOriginIsolated: readCrossOriginIsolated(),
    runtimeInitAttempts,
    failureStage,
    failureCode,
    requiresReload: runtimeFailed,
  };
}

export function isOrtRuntimeReloadRequired(): boolean {
  return runtimeFailed;
}

/** Test helper: swap loaders and clear page-level state. */
export function resetOrtRuntimeForTests(overrides: Partial<RuntimeHooks> = {}): void {
  hooks = { ...defaultHooks, ...overrides };
  modulePromise = null;
  assetsPromise = null;
  assetsReady = false;
  runtimeInitPromise = null;
  runtimeProbePromise = null;
  runtimeReady = false;
  runtimeFailed = false;
  runtimeInitAttempts = 0;
  ortVersion = null;
  failureStage = null;
  failureCode = null;
  state = "IDLE";
}
