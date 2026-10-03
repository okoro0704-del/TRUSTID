/**
 * Biometric runtime initialization: one ORT runtime init per page.
 *
 * The fake web backend below copies the init semantics of onnxruntime-web
 * 1.21 (lib/wasm/proxy-wrapper.ts initializeWebAssemblyAndOrtRuntime) and is
 * registered into the REAL onnxruntime-common registry under the same names
 * the default bundle uses, so per-backend init sharing and sticky "aborted"
 * errors are the library's own behavior.
 */
import { createElement, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const download = vi.hoisted(() => ({
  failuresLeft: 0,
  calls: 0,
}));

vi.mock("../src/capture/biometric/resumable-download.js", () => ({
  downloadModelBytes: vi.fn(async () => {
    download.calls += 1;
    if (download.failuresLeft > 0) {
      download.failuresLeft -= 1;
      throw new Error("Model range failed (503) at 0-262143");
    }
    return new ArrayBuffer(64);
  }),
}));

vi.mock("../src/capture/biometric/integrity.js", async () => {
  const manifest = await import("../src/capture/biometric/model-manifest.js");
  return {
    sha256Hex: async () => manifest.ARCFACE_MBF_ARTIFACT.sha256,
    fetchVerifiedArtifact: async () => new ArrayBuffer(0),
  };
});

const mediapipe = vi.hoisted(() => ({ creates: 0 }));

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  FaceLandmarker: {
    createFromOptions: async () => {
      mediapipe.creates += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { detect: () => ({ faceLandmarks: [] }) };
    },
  },
}));

type Counters = {
  runtimeInitEntered: number;
  backendInitByName: Record<string, number>;
  sessionsCreated: number;
};

type FakeOptions = {
  initMs?: number;
  initError?: string;
  sessionFailuresLeft?: number;
};

const ORT_VERSION = "1.21.0";

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function freshFakeOrt(options: FakeOptions = {}) {
  const common = await import("onnxruntime-common");
  let initializing = false;
  let initialized = false;
  let aborted = false;
  let sessionFailuresLeft = options.sessionFailuresLeft ?? 0;
  const counters: Counters = {
    runtimeInitEntered: 0,
    backendInitByName: {},
    sessionsCreated: 0,
  };

  // Mirrors onnxruntime-web/lib/wasm/proxy-wrapper.ts (non-proxy branch).
  async function initializeWebAssemblyAndOrtRuntime() {
    if (initialized) return;
    if (initializing) throw new Error("multiple calls to 'initWasm()' detected.");
    if (aborted) throw new Error("previous call to 'initWasm()' failed.");
    initializing = true;
    counters.runtimeInitEntered += 1;
    try {
      await delay(options.initMs ?? 0);
      if (options.initError) throw new Error(options.initError);
      initialized = true;
    } catch (e) {
      aborted = true;
      throw e;
    } finally {
      initializing = false;
    }
  }

  const backend = {
    async init(name: string) {
      counters.backendInitByName[name] = (counters.backendInitByName[name] ?? 0) + 1;
      await initializeWebAssemblyAndOrtRuntime();
    },
    async createInferenceSessionHandler() {
      if (sessionFailuresLeft > 0) {
        sessionFailuresLeft -= 1;
        throw new Error("Can't create a session. failed to load model");
      }
      counters.sessionsCreated += 1;
      return {
        inputNames: ["input.1"],
        outputNames: ["683"],
        dispose: async () => {},
        startProfiling: () => {},
        endProfiling: () => {},
        run: async () => ({
          "683": { data: new Float32Array(512).fill(0.5), dims: [1, 512], type: "float32" },
        }),
      };
    },
  };

  // Same registrations as onnxruntime-web/lib/index.ts (JSEP build).
  common.registerBackend("webgpu", backend as never, 5);
  common.registerBackend("webnn", backend as never, 5);
  common.registerBackend("cpu", backend as never, 10);
  common.registerBackend("wasm", backend as never, 10);
  Object.defineProperty(common.env.versions, "web", {
    value: ORT_VERSION,
    enumerable: true,
    configurable: true,
  });

  const createSpy = vi.spyOn(common.InferenceSession, "create");
  const module = {
    InferenceSession: common.InferenceSession,
    Tensor: common.Tensor,
    env: common.env,
  };
  return { module, counters, createSpy };
}

function validWasmBinary(): ArrayBuffer {
  const bytes = new Uint8Array(1024 * 1024 + 16);
  bytes.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return bytes.buffer;
}

async function setup(options: FakeOptions = {}) {
  vi.resetModules();
  const fake = await freshFakeOrt(options);
  const runtime = await import("../src/capture/biometric/ort-runtime.js");
  const arcface = await import("../src/capture/biometric/recognizer-arcface.js");
  const binaryFetches: string[] = [];
  const modulePreloads: string[] = [];
  let importCalls = 0;
  runtime.resetOrtRuntimeForTests({
    importOrt: async () => {
      importCalls += 1;
      return fake.module as never;
    },
    fetchBinary: async (url) => {
      binaryFetches.push(url);
      return validWasmBinary();
    },
    preloadModule: async (url) => {
      modulePreloads.push(url);
      return { default: () => undefined };
    },
    origin: () => "https://trustedid.netlify.app",
  });
  arcface.resetArcFaceSessionForTests();
  return {
    ...fake,
    runtime,
    arcface,
    binaryFetches,
    modulePreloads,
    importCalls: () => importCalls,
  };
}

const MODEL = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  download.failuresLeft = 0;
  download.calls = 0;
  mediapipe.creates = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Each test cold-imports a fresh onnxruntime-common; allow for loaded CI machines.
const RUNTIME_TEST_TIMEOUT_MS = 20_000;

describe("root cause reproduction (pre-fix initialization path)", { timeout: RUNTIME_TEST_TIMEOUT_MS }, () => {
  it("a timed-out WebGPU session followed by a WASM session yields the production error and poisons retries", async () => {
    vi.resetModules();
    const { module, counters } = await freshFakeOrt({ initMs: 40 });
    const ort = module as unknown as {
      InferenceSession: { create: (m: Uint8Array, o: unknown) => Promise<unknown> };
    };

    // Old getArcFaceSession: race WebGPU create against a timeout ...
    const webgpu = ort.InferenceSession.create(MODEL, { executionProviders: ["webgpu"] });
    webgpu.catch(() => undefined);
    await expect(
      Promise.race([
        webgpu,
        delay(5).then(() => {
          throw new Error("WebGPU InferenceSession.create timed out after 8000ms");
        }),
      ]),
    ).rejects.toThrow(/timed out/);

    // ... then fall back to WASM while the WebGPU init is still running.
    await expect(
      ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"] }),
    ).rejects.toThrow(
      "no available backend found. ERR: [wasm] Error: multiple calls to 'initWasm()' detected.",
    );

    // Retrying never recovers: ORT caches the aborted "wasm" backend.
    await webgpu.catch(() => undefined);
    await expect(
      ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"] }),
    ).rejects.toThrow("multiple calls to 'initWasm()' detected.");
    expect(counters.backendInitByName).toEqual({ webgpu: 1, wasm: 1 });
  });
});

describe("ORT runtime owner", { timeout: RUNTIME_TEST_TIMEOUT_MS }, () => {
  it("1. ten sequential session requests initialize the runtime once", async () => {
    const t = await setup();
    for (let i = 0; i < 10; i++) {
      await t.runtime.createOrtSession(MODEL);
    }
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.runtime.getOrtRuntimeStatus().runtimeInitAttempts).toBe(1);
    expect(t.importCalls()).toBe(1);
    expect(t.binaryFetches).toHaveLength(1);
  });

  it("2. ten concurrent session requests share one runtime init", async () => {
    const t = await setup({ initMs: 20 });
    const sessions = await Promise.all(
      Array.from({ length: 10 }, () => t.runtime.createOrtSession(MODEL)),
    );
    expect(sessions).toHaveLength(10);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.runtime.getOrtRuntimeStatus().state).toBe("READY");
    expect(t.binaryFetches).toHaveLength(1);
  });

  it("2b. ten concurrent ArcFace loads return the same session", async () => {
    const t = await setup({ initMs: 20 });
    const sessions = await Promise.all(
      Array.from({ length: 10 }, () => t.arcface.getArcFaceSession()),
    );
    expect(new Set(sessions).size).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    expect(download.calls).toBe(1);
    expect(t.arcface.isArcFaceReady()).toBe(true);
  });

  it("uses only the wasm provider, version-scoped same-origin assets and a preloaded binary", async () => {
    const t = await setup();
    await t.runtime.createOrtSession(MODEL);
    const providers = t.createSpy.mock.calls.map(
      (c) => (c[1] as { executionProviders: string[] }).executionProviders,
    );
    expect(providers).toEqual([["wasm"]]);
    expect(t.counters.backendInitByName).toEqual({ wasm: 1 });
    expect(t.binaryFetches).toEqual([
      `https://trustedid.netlify.app/ort/${ORT_VERSION}/ort-wasm-simd-threaded.wasm`,
    ]);
    expect(t.modulePreloads).toEqual([
      `https://trustedid.netlify.app/ort/${ORT_VERSION}/ort-wasm-simd-threaded.mjs`,
    ]);
    expect(t.module.env.wasm.numThreads).toBe(1);
    expect(t.module.env.wasm.proxy).toBe(false);
    expect(t.module.env.wasm.wasmPaths).toEqual({
      mjs: `https://trustedid.netlify.app/ort/${ORT_VERSION}/ort-wasm-simd-threaded.mjs`,
    });
    const status = t.runtime.getOrtRuntimeStatus();
    expect(status).toMatchObject({
      state: "READY",
      ortVersion: ORT_VERSION,
      executionProvider: "wasm",
      numThreads: 1,
      requiresReload: false,
    });
  });

  it("3. StrictMode double mount does not initialize twice", async () => {
    const t = await setup({ initMs: 10 });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let effects = 0;
    function Scanner() {
      useEffect(() => {
        effects += 1;
        void t.arcface.getArcFaceSession().catch(() => undefined);
      }, []);
      return null;
    }
    const host = document.createElement("div");
    let root!: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(StrictMode, null, createElement(Scanner)));
    });
    await act(async () => {
      await t.arcface.getArcFaceSession();
    });
    expect(effects).toBe(2);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    await act(async () => root.unmount());
  });

  it("4. navigating away and back reuses the ready runtime and session", async () => {
    const t = await setup();
    const first = await t.arcface.getArcFaceSession();
    // Screen unmounts; a later screen asks again.
    const second = await t.arcface.getArcFaceSession();
    await t.arcface.embedAlignedFace112(new Float32Array(3 * 112 * 112));
    expect(second).toBe(first);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
  });

  it("5. a failed model load retries without re-initializing the runtime", async () => {
    const t = await setup();
    await t.runtime.createOrtSession(MODEL);
    download.failuresLeft = 4;
    await expect(t.arcface.getArcFaceSession()).rejects.toMatchObject({
      code: "BIOMETRIC_MODEL_UNAVAILABLE",
    });
    expect(t.arcface.getArcFaceEmbedderState()).toBe("FAILED");
    download.failuresLeft = 0;
    await t.arcface.getArcFaceSession();
    expect(t.arcface.getArcFaceEmbedderState()).toBe("READY");
    expect(t.counters.runtimeInitEntered).toBe(1);
  });

  it("5b. a failed first session (bad model) leaves one runtime init and recovers", async () => {
    const t = await setup({ sessionFailuresLeft: 1 });
    await expect(t.arcface.getArcFaceSession()).rejects.toThrow(
      /BIOMETRIC_SESSION_FAILED/,
    );
    expect(t.runtime.getOrtRuntimeStatus().state).toBe("READY");
    await t.arcface.getArcFaceSession();
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.runtime.getOrtRuntimeStatus().runtimeInitAttempts).toBe(1);
  });

  it("6. rapid retry presses after a failure race into one load", async () => {
    const t = await setup({ initMs: 15 });
    download.failuresLeft = 1;
    await expect(t.arcface.getArcFaceSession()).rejects.toBeTruthy();
    const callsAfterFailure = download.calls;
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => t.arcface.getArcFaceSession()),
    );
    expect(new Set(sessions).size).toBe(1);
    expect(download.calls - callsAfterFailure).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
  });

  it("7. detector and embedder loading concurrently share one runtime init", async () => {
    const t = await setup({ initMs: 15 });
    const extractorModule = await import("../src/capture/ai-vector-extractor.js");
    const detector = await import("../src/capture/biometric/detector-mediapipe.js");
    const status = await import("../src/capture/biometric/runtime-status.js");
    detector.resetSharedFaceLandmarkerForTests();
    extractorModule.resetSharedAIVectorExtractorForTests();

    const extractors = await Promise.all([
      extractorModule.getSharedAIVectorExtractor(),
      extractorModule.getSharedAIVectorExtractor(),
      t.arcface.getArcFaceSession(),
      detector.getSharedFaceLandmarker(),
      t.arcface.embedAlignedFace112(new Float32Array(3 * 112 * 112)),
      extractorModule.getSharedAIVectorExtractor(),
    ]);
    expect(extractors[0]).toBe(extractors[1]);
    expect((extractors[0] as { isReady: () => boolean }).isReady()).toBe(true);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    expect(mediapipe.creates).toBe(1);
    expect(status.getBiometricRuntimeStatus()).toMatchObject({
      ready: true,
      failed: false,
      embedder: "READY",
      detector: { state: "READY" },
      runtime: { state: "READY" },
    });
  });

  it("8. a real runtime init failure fails closed and is never re-initialized", async () => {
    const t = await setup({ initError: "Aborted(CompileError: WebAssembly.instantiate(): out of memory)" });
    const err = await t.arcface.getArcFaceSession().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BIOMETRIC_MODEL_UNAVAILABLE" });
    expect(String((err as Error).message)).toMatch(/BIOMETRIC_RUNTIME_FAILED/);
    expect(String((err as Error).message)).not.toMatch(/initWasm|CompileError/);

    const status = t.runtime.getOrtRuntimeStatus();
    expect(status).toMatchObject({
      state: "FAILED",
      requiresReload: true,
      failureCode: "BIOMETRIC_RUNTIME_FAILED",
      failureStage: "init",
    });

    // Retries fail fast with the same deterministic error and never touch ORT init.
    for (let i = 0; i < 3; i++) {
      await expect(t.arcface.getArcFaceSession()).rejects.toThrow(/BIOMETRIC_RUNTIME_FAILED/);
    }
    await expect(
      t.arcface.embedAlignedFace112(new Float32Array(3 * 112 * 112)),
    ).rejects.toMatchObject({ code: "BIOMETRIC_MODEL_UNAVAILABLE" });
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(0);
    expect(t.arcface.isArcFaceReady()).toBe(false);
  });

  it("missing runtime assets (SPA HTML fallback) are retryable and never reach ORT init", async () => {
    const t = await setup();
    let serveHtml = true;
    t.runtime.resetOrtRuntimeForTests({
      importOrt: async () => t.module as never,
      fetchBinary: async () =>
        serveHtml
          ? new TextEncoder().encode("<!doctype html><html></html>").buffer
          : validWasmBinary(),
      preloadModule: async () => ({ default: () => undefined }),
      origin: () => "https://trustedid.netlify.app",
    });
    await expect(t.runtime.createOrtSession(MODEL)).rejects.toThrow(
      /BIOMETRIC_RUNTIME_ASSETS_UNAVAILABLE/,
    );
    expect(t.counters.runtimeInitEntered).toBe(0);
    expect(t.runtime.getOrtRuntimeStatus().requiresReload).toBe(false);

    serveHtml = false;
    await t.runtime.createOrtSession(MODEL);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.runtime.getOrtRuntimeStatus().state).toBe("READY");
  });
});
