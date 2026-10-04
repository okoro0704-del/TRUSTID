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
  /** Failures for the ArcFace model download (the historical default). */
  failuresLeft: 0,
  calls: 0,
  urls: [] as string[],
  /** Per-URL-fragment failure: thrown instead of returning bytes. */
  failFor: new Map<string, () => Error>(),
  /** Per-URL-fragment body override (e.g. an HTML page). */
  bodyFor: new Map<string, () => ArrayBuffer>(),
  /** Hold a download until released. */
  holdFor: new Map<string, Promise<void>>(),
}));

/** 77-byte stand-in for face_landmarker.task; the sha256 mock keys on length. */
const TASK_BYTES = 77;

vi.mock("../src/capture/biometric/resumable-download.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/capture/biometric/resumable-download.js")>()),
  downloadModelBytes: vi.fn(async (url: string) => {
    download.calls += 1;
    download.urls.push(url);
    for (const [fragment, hold] of download.holdFor) {
      if (url.includes(fragment)) await hold;
    }
    for (const [fragment, fail] of download.failFor) {
      if (url.includes(fragment)) throw fail();
    }
    for (const [fragment, body] of download.bodyFor) {
      if (url.includes(fragment)) return body();
    }
    if (url.endsWith(".task")) return new ArrayBuffer(TASK_BYTES);
    if (download.failuresLeft > 0) {
      download.failuresLeft -= 1;
      throw new Error("ASSET_HTTP_ERROR: HTTP 503 at 0-262143");
    }
    return new ArrayBuffer(64);
  }),
}));

vi.mock("../src/capture/biometric/integrity.js", async () => {
  const manifest = await import("../src/capture/biometric/model-manifest.js");
  return {
    // 0xEE first byte marks a stale/corrupt copy in these tests.
    sha256Hex: async (data: ArrayBuffer) =>
      new Uint8Array(data)[0] === 0xee
        ? "0".repeat(64)
        : data.byteLength === 77
          ? manifest.MEDIAPIPE_FACE_LANDMARKER_ARTIFACT.sha256
          : manifest.ARCFACE_MBF_ARTIFACT.sha256,
    fetchVerifiedArtifact: async () => new ArrayBuffer(0),
  };
});

const mediapipe = vi.hoisted(() => ({
  creates: 0,
  failCreatesLeft: 0,
  detectCalls: 0,
  detectResult: { faceLandmarks: [] } as unknown,
  lastOptions: null as Record<string, unknown> | null,
  fileset: {} as Record<string, string>,
}));

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: async () => ({ ...mediapipe.fileset }) },
  FaceLandmarker: {
    createFromOptions: async (_fileset: unknown, opts: Record<string, unknown>) => {
      mediapipe.creates += 1;
      mediapipe.lastOptions = opts;
      await new Promise((r) => setTimeout(r, 5));
      if (mediapipe.failCreatesLeft > 0) {
        mediapipe.failCreatesLeft -= 1;
        throw new Error("FaceLandmarker.createFromOptions failed");
      }
      return {
        detect: () => {
          mediapipe.detectCalls += 1;
          return mediapipe.detectResult;
        },
      };
    },
  },
}));

type Counters = {
  runtimeInitEntered: number;
  backendInitByName: Record<string, number>;
  /** ArcFace (non-probe) sessions. */
  sessionsCreated: number;
  probeSessions: number;
  runsInflight: number;
  maxRunsInflight: number;
};

type FakeOptions = {
  initMs?: number;
  runMs?: number;
  initError?: string;
  sessionFailuresLeft?: number;
  /** Values the ArcFace session returns (default 512 x 0.5). */
  embedOutput?: () => Float32Array;
};

const PROBE_MODEL_BYTES = 63;

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
    probeSessions: 0,
    runsInflight: 0,
    maxRunsInflight: 0,
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
    async createInferenceSessionHandler(model: Uint8Array) {
      if (model?.byteLength === PROBE_MODEL_BYTES) {
        counters.probeSessions += 1;
        return {
          inputNames: ["x"],
          outputNames: ["y"],
          dispose: async () => {},
          startProfiling: () => {},
          endProfiling: () => {},
          run: async (feeds: Record<string, unknown>) => ({ y: feeds.x }),
        };
      }
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
        run: async () => {
          counters.runsInflight += 1;
          counters.maxRunsInflight = Math.max(counters.maxRunsInflight, counters.runsInflight);
          await delay(options.runMs ?? 0);
          counters.runsInflight -= 1;
          const data = options.embedOutput?.() ?? new Float32Array(512).fill(0.5);
          return {
            "683": { data, dims: [1, data.length], type: "float32" },
          };
        },
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
  download.urls = [];
  download.failFor.clear();
  download.bodyFor.clear();
  download.holdFor.clear();
  mediapipe.creates = 0;
  mediapipe.failCreatesLeft = 0;
  mediapipe.detectCalls = 0;
  mediapipe.detectResult = { faceLandmarks: [] };
  mediapipe.lastOptions = null;
  mediapipe.fileset = {};
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

  it("4b. overlapping embed requests run the ArcFace session one at a time", async () => {
    const t = await setup({ runMs: 15 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.arcface.embedAlignedFace112(new Float32Array(3 * 112 * 112)),
      ),
    );
    expect(results.every((r) => r.vector.length === 512)).toBe(true);
    expect(t.counters.maxRunsInflight).toBe(1);
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

/** Minimal Cache Storage for jsdom (which has none). */
class FakeCache {
  readonly entries = new Map<string, Uint8Array>();
  private key(req: RequestInfo | URL): string {
    if (typeof req === "string") return new URL(req, "https://trustedid.netlify.app").href;
    return req instanceof URL ? req.href : req.url;
  }
  async match(req: RequestInfo | URL) {
    const hit = this.entries.get(this.key(req));
    return hit ? new Response(hit.slice()) : undefined;
  }
  async put(req: RequestInfo | URL, res: Response) {
    this.entries.set(this.key(req), new Uint8Array(await res.arrayBuffer()));
  }
  async delete(req: RequestInfo | URL) {
    return this.entries.delete(this.key(req));
  }
  async keys() {
    return [...this.entries.keys()].map((k) => new Request(k));
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.stores.get(name);
    if (!c) {
      c = new FakeCache();
      this.stores.set(name, c);
    }
    return c;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

async function setupReadiness(options: FakeOptions = {}) {
  const t = await setup(options);
  const readiness = await import("../src/capture/biometric/biometric-readiness.js");
  const cache = await import("../src/capture/biometric/biometric-asset-cache.js");
  return { ...t, readiness, cache };
}

describe("biometric readiness", { timeout: RUNTIME_TEST_TIMEOUT_MS }, () => {
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("BIOMETRIC_READY requires runtime, detector, embedder and warm-up, reached in that order", async () => {
    const t = await setupReadiness();
    expect(t.readiness.getBiometricReadiness().stage).toBe("IDLE");
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap).toMatchObject({
      stage: "BIOMETRIC_READY",
      ready: true,
      failed: false,
      requiresReload: false,
      runtime: { state: "READY" },
      detector: { state: "READY" },
      embedder: { state: "READY" },
      warmup: { state: "READY" },
    });
    const order = snap.transitions;
    expect(new Set(order.slice(0, 3))).toEqual(
      new Set(["RUNTIME_READY", "DETECTOR_READY", "EMBEDDER_READY"]),
    );
    expect(order.slice(3)).toEqual(["WARMUP_READY", "BIOMETRIC_READY"]);
    // The warm-up really ran the detector and the embedder once each.
    expect(mediapipe.detectCalls).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.probeSessions).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    expect(t.runtime.getOrtRuntimeStatus().runtimeInitAttempts).toBe(1);
  });

  it("the runtime is ready before any model download finishes", async () => {
    const t = await setupReadiness();
    let release!: () => void;
    download.holdFor.set("w600k_mbf.onnx", new Promise<void>((r) => (release = r)));
    const pending = t.readiness.ensureBiometricReady();
    await vi.waitFor(() => {
      expect(t.readiness.getBiometricReadiness().runtime.state).toBe("READY");
    });
    const mid = t.readiness.getBiometricReadiness();
    expect(mid.embedder.state).toBe("LOADING");
    expect(mid.ready).toBe(false);
    expect(mid.stage).toBe("EMBEDDER_LOADING");
    release();
    expect((await pending).ready).toBe(true);
    expect(t.counters.runtimeInitEntered).toBe(1);
  });

  it("concurrent callers share one initializer", async () => {
    const t = await setupReadiness({ initMs: 15 });
    const snaps = await Promise.all(
      Array.from({ length: 10 }, () => t.readiness.ensureBiometricReady()),
    );
    expect(snaps.every((s) => s.ready)).toBe(true);
    expect(t.readiness.getBiometricReadiness().passes).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.probeSessions).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    expect(mediapipe.creates).toBe(1);
    expect(download.urls.filter((u) => u.endsWith("w600k_mbf.onnx"))).toHaveLength(1);
  });

  it("a detector failure is not ready; retry reloads only the detector", async () => {
    const t = await setupReadiness();
    mediapipe.failCreatesLeft = 1;
    const failed = await t.readiness.ensureBiometricReady();
    expect(failed).toMatchObject({
      ready: false,
      failed: true,
      stage: "DETECTOR_FAILED",
      runtime: { state: "READY" },
      detector: { state: "FAILED", failureCategory: "SESSION_CREATE" },
      embedder: { state: "READY" },
      warmup: { state: "IDLE" },
    });
    const retried = await t.readiness.ensureBiometricReady();
    expect(retried.ready).toBe(true);
    expect(mediapipe.creates).toBe(2);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    // The detector assets were fetched once; the retry reused them.
    expect(download.urls.filter((u) => u.endsWith(".task"))).toHaveLength(1);
  });

  it("an embedder download failure is not ready; retry does not re-initialize WASM or duplicate sessions", async () => {
    const t = await setupReadiness();
    download.failFor.set("w600k_mbf.onnx", () => new Error("ASSET_NETWORK_ERROR: Failed to fetch"));
    const failed = await t.readiness.ensureBiometricReady();
    expect(failed).toMatchObject({
      ready: false,
      stage: "EMBEDDER_FAILED",
      runtime: { state: "READY" },
      detector: { state: "READY" },
      embedder: { state: "FAILED", failureCategory: "NETWORK" },
    });
    download.failFor.clear();
    const retried = await t.readiness.ensureBiometricReady();
    expect(retried.ready).toBe(true);
    expect(retried.embedder.attempts).toBe(2);
    expect(retried.runtime.attempts).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.probeSessions).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    expect(mediapipe.creates).toBe(1);
  });

  it("a warm-up failure is not ready and retries only the warm-up", async () => {
    let bad = true;
    const t = await setupReadiness({
      embedOutput: () => (bad ? new Float32Array(10) : new Float32Array(512).fill(0.5)),
    });
    const failed = await t.readiness.ensureBiometricReady();
    expect(failed).toMatchObject({
      ready: false,
      stage: "WARMUP_FAILED",
      runtime: { state: "READY" },
      detector: { state: "READY" },
      embedder: { state: "READY" },
      warmup: { state: "FAILED", failureCategory: "WARMUP_INVALID" },
    });
    bad = false;
    const retried = await t.readiness.ensureBiometricReady();
    expect(retried.ready).toBe(true);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
    expect(mediapipe.creates).toBe(1);
  });

  it("a non-finite warm-up output is not ready", async () => {
    const t = await setupReadiness({
      embedOutput: () => new Float32Array(512).fill(Number.NaN),
    });
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(false);
    expect(snap.warmup.failureCategory).toBe("WARMUP_INVALID");
  });

  it("a missing .onnx is an explicit asset failure, not a load that never ends", async () => {
    const t = await setupReadiness();
    const { BiometricAssetError } = await import("../src/capture/biometric/resumable-download.js");
    download.failFor.set(
      "w600k_mbf.onnx",
      () => new BiometricAssetError("ASSET_MISSING", "/models/trustid/w600k_mbf.onnx", "HTTP 404", 404),
    );
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap).toMatchObject({
      ready: false,
      failed: true,
      requiresReload: true,
      embedder: { state: "FAILED", failureCategory: "ASSET_MISSING" },
    });
    expect(snap.embedder.error).toMatch(/ASSET_MISSING/);
  });

  it("HTML served for an .onnx is rejected as not a binary", async () => {
    const t = await setupReadiness();
    const { BiometricAssetError } = await import("../src/capture/biometric/resumable-download.js");
    download.failFor.set(
      "w600k_mbf.onnx",
      () => new BiometricAssetError("ASSET_NOT_BINARY", "/models/trustid/w600k_mbf.onnx", "served as text/html", 200),
    );
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(false);
    expect(snap.embedder.failureCategory).toBe("ASSET_NOT_BINARY");
  });

  it("a missing ORT .wasm is an explicit runtime failure and never reaches ORT init", async () => {
    const t = await setupReadiness();
    const { BiometricAssetError } = await import("../src/capture/biometric/resumable-download.js");
    t.runtime.resetOrtRuntimeForTests({
      importOrt: async () => t.module as never,
      fetchBinary: async (url) => {
        throw new BiometricAssetError("ASSET_MISSING", url, "HTTP 404", 404);
      },
      preloadModule: async () => ({ default: () => undefined }),
      origin: () => "https://trustedid.netlify.app",
    });
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap).toMatchObject({
      ready: false,
      stage: "RUNTIME_FAILED",
      runtime: { state: "FAILED", failureCategory: "ASSET_MISSING" },
    });
    expect(snap.runtime.error).toMatch(/BIOMETRIC_RUNTIME_ASSETS_UNAVAILABLE/);
    expect(t.counters.runtimeInitEntered).toBe(0);
  });

  it("a missing MediaPipe .wasm is an explicit detector failure", async () => {
    const t = await setupReadiness();
    const { BiometricAssetError } = await import("../src/capture/biometric/resumable-download.js");
    mediapipe.fileset = {
      wasmLoaderPath: "/mediapipe/0.10.18/vision_wasm_internal.js",
      wasmBinaryPath: "/mediapipe/0.10.18/vision_wasm_internal.wasm",
    };
    download.failFor.set(
      "vision_wasm_internal.wasm",
      () => new BiometricAssetError("ASSET_MISSING", "/mediapipe/0.10.18/vision_wasm_internal.wasm", "HTTP 404", 404),
    );
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(false);
    expect(snap.detector).toMatchObject({ state: "FAILED", failureCategory: "ASSET_MISSING" });
    expect(mediapipe.creates).toBe(0);
  });

  it("the detector is created from prefetched, verified bytes (no second download on fallback)", async () => {
    const t = await setupReadiness();
    mediapipe.fileset = {
      wasmLoaderPath: "/mediapipe/0.10.18/vision_wasm_internal.js",
      wasmBinaryPath: "/mediapipe/0.10.18/vision_wasm_internal.wasm",
    };
    download.bodyFor.set("vision_wasm_internal.wasm", validWasmBinary);
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(true);
    const base = mediapipe.lastOptions?.baseOptions as Record<string, unknown>;
    expect(base.modelAssetPath).toBeUndefined();
    expect((base.modelAssetBuffer as Uint8Array).byteLength).toBe(TASK_BYTES);
    expect(download.urls.filter((u) => u.includes("vision_wasm_internal.wasm"))).toHaveLength(1);
    expect(download.urls.filter((u) => u.endsWith(".task"))).toHaveLength(1);
  });

  it("an HTML page served for the MediaPipe .wasm is rejected", async () => {
    const t = await setupReadiness();
    mediapipe.fileset = {
      wasmLoaderPath: "/mediapipe/0.10.18/vision_wasm_internal.js",
      wasmBinaryPath: "/mediapipe/0.10.18/vision_wasm_internal.wasm",
    };
    download.bodyFor.set(
      "vision_wasm_internal.wasm",
      () => new TextEncoder().encode("<!doctype html><html></html>").buffer as ArrayBuffer,
    );
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.detector).toMatchObject({ state: "FAILED", failureCategory: "ASSET_NOT_BINARY" });
    expect(mediapipe.creates).toBe(0);
  });

  it("a stale cached model is discarded and re-downloaded; legacy caches and other builds' entries are pruned", async () => {
    const storage = new FakeCacheStorage();
    (globalThis as { caches?: unknown }).caches = storage;
    const t = await setupReadiness();
    const bucket = await storage.open(t.cache.BIOMETRIC_ASSET_CACHE);
    await bucket.put(t.cache.BIOMETRIC_ASSET_KEYS.arcface(), new Response(new Uint8Array([0xee, 1, 2, 3])));
    await bucket.put(t.cache.BIOMETRIC_ASSET_KEYS.ortWasm("1.20.0"), new Response(new Uint8Array(validWasmBinary())));
    await storage.open("trustid-models-0123456789abcdef");
    await storage.open("trustid-ort-1.20.0");

    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(true);
    expect(download.urls.filter((u) => u.endsWith("w600k_mbf.onnx"))).toHaveLength(1);
    const stored = bucket.entries.get(
      new URL(t.cache.BIOMETRIC_ASSET_KEYS.arcface(), "https://trustedid.netlify.app").href,
    );
    expect(stored?.[0]).not.toBe(0xee);
    await vi.waitFor(async () => {
      expect(await storage.keys()).toEqual([t.cache.BIOMETRIC_ASSET_CACHE]);
      const keys = [...bucket.entries.keys()].map((k) => new URL(k).pathname);
      expect(keys).not.toContain(t.cache.BIOMETRIC_ASSET_KEYS.ortWasm("1.20.0"));
    });
  });

  it("a stale cached model with no network fails closed instead of being used", async () => {
    const storage = new FakeCacheStorage();
    (globalThis as { caches?: unknown }).caches = storage;
    const t = await setupReadiness();
    const bucket = await storage.open(t.cache.BIOMETRIC_ASSET_CACHE);
    await bucket.put(t.cache.BIOMETRIC_ASSET_KEYS.arcface(), new Response(new Uint8Array([0xee, 1, 2, 3])));
    download.failFor.set("w600k_mbf.onnx", () => new Error("ASSET_NETWORK_ERROR: offline"));
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(false);
    expect(snap.embedder.state).toBe("FAILED");
    expect(t.counters.sessionsCreated).toBe(0);
  });

  it("a cached copy is used on the next page load without downloading", async () => {
    const storage = new FakeCacheStorage();
    (globalThis as { caches?: unknown }).caches = storage;
    const first = await setupReadiness();
    expect((await first.readiness.ensureBiometricReady()).ready).toBe(true);
    const downloadsAfterFirst = download.urls.length;
    // New page: fresh modules, same Cache Storage.
    const second = await setupReadiness();
    const snap = await second.readiness.ensureBiometricReady();
    expect(snap.ready).toBe(true);
    expect(snap.embedder.fromCache).toBe(true);
    expect(download.urls.slice(downloadsAfterFirst).filter((u) => u.endsWith("w600k_mbf.onnx"))).toHaveLength(0);
  });

  it("remounts and navigating away and back never start another initialization", async () => {
    const t = await setupReadiness();
    await t.readiness.ensureBiometricReady();
    for (let i = 0; i < 5; i++) {
      expect((await t.readiness.ensureBiometricReady()).ready).toBe(true);
    }
    expect(t.readiness.getBiometricReadiness().passes).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.probeSessions).toBe(1);
    expect(mediapipe.creates).toBe(1);
  });

  it("a StrictMode double mount starts one initializer", async () => {
    const t = await setupReadiness({ initMs: 10 });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let effects = 0;
    function Scanner() {
      useEffect(() => {
        effects += 1;
        void t.readiness.ensureBiometricReady();
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
      await t.readiness.ensureBiometricReady();
    });
    expect(effects).toBe(2);
    expect(t.readiness.getBiometricReadiness().passes).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    await act(async () => root.unmount());
  });

  it("rapid retries after a failure race into a single initializer", async () => {
    const t = await setupReadiness({ initMs: 10 });
    download.failFor.set("w600k_mbf.onnx", () => new Error("ASSET_STALLED: no bytes for 30000ms"));
    const failed = await t.readiness.ensureBiometricReady();
    expect(failed.embedder.failureCategory).toBe("ASSET_STALLED");
    download.failFor.clear();
    const before = download.urls.length;
    const snaps = await Promise.all(
      Array.from({ length: 6 }, () => t.readiness.ensureBiometricReady()),
    );
    expect(snaps.every((s) => s.ready)).toBe(true);
    expect(t.readiness.getBiometricReadiness().passes).toBe(2);
    expect(download.urls.slice(before).filter((u) => u.endsWith("w600k_mbf.onnx"))).toHaveLength(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
    expect(t.counters.sessionsCreated).toBe(1);
  });

  it("an ORT runtime init failure needs a reload and is never retried", async () => {
    const t = await setupReadiness({ initError: "Aborted(CompileError: WebAssembly.instantiate(): out of memory)" });
    const snap = await t.readiness.ensureBiometricReady();
    expect(snap).toMatchObject({
      ready: false,
      requiresReload: true,
      runtime: { state: "FAILED", failureCategory: "RUNTIME_INIT" },
    });
    const again = await t.readiness.ensureBiometricReady();
    expect(again.passes).toBe(1);
    expect(t.counters.runtimeInitEntered).toBe(1);
  });

  it("listeners get progress without frames, landmarks or vectors", async () => {
    const t = await setupReadiness();
    const seen: string[] = [];
    t.readiness.subscribeBiometricReadiness((s) => seen.push(JSON.stringify(s)));
    await t.readiness.ensureBiometricReady();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s).not.toMatch(/vector|embedding|landmark|template|imageData/i);
    }
  });
});
