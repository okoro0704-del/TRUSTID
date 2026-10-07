/**
 * Prewarm makes face recognition ready before sign-in without ever opening
 * the camera: immediately in the native app, after an idle asset prefetch on
 * the web, and never as a background init on low-memory or Save-Data devices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readiness = vi.hoisted(() => ({ ensureCalls: 0 }));

vi.mock("../src/capture/biometric/biometric-readiness.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/capture/biometric/biometric-readiness.js")>();
  const ready = () => {
    const report = { state: "READY", attempts: 1, durationMs: 1, assetUrl: null, bytesLoaded: null, bytesTotal: null, fromCache: null, failureCategory: null, error: null };
    return { stage: "BIOMETRIC_READY", ready: true, failed: false, loading: false, requiresReload: false, runtime: report, detector: report, embedder: report, warmup: report, transitions: [], passes: 1 };
  };
  return {
    ...real,
    ensureBiometricReady: vi.fn(async () => {
      readiness.ensureCalls += 1;
      return ready();
    }),
  };
});

type Nav = Navigator & { connection?: unknown; deviceMemory?: number };

async function load() {
  vi.resetModules();
  const engine = await import("../src/capture/biometric/biometric-engine.js");
  const delivery = await import("../src/capture/biometric/asset-delivery.js");
  engine.resetBiometricPrewarmForTests();
  delivery.resetBiometricDeliveryForTests();
  return { engine, delivery };
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  readiness.ensureCalls = 0;
  getUserMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
});

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  Object.defineProperty(navigator, "connection", { value: undefined, configurable: true });
  Object.defineProperty(navigator as Nav, "deviceMemory", { value: undefined, configurable: true });
  delete (globalThis as { caches?: unknown }).caches;
  vi.restoreAllMocks();
});

describe("prewarmBiometricEngine", () => {
  it("native app: initializes the engine at launch, without the camera", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
    const { engine } = await load();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await engine.prewarmBiometricEngine();
    expect(result).toMatchObject({ platform: "android", mode: "engine", status: { state: "READY" } });
    expect(readiness.ensureCalls).toBe(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schedulePrewarmBiometricEngine runs once per page however often it is called", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
    const { engine } = await load();
    const results = await Promise.all([1, 2, 3].map(() => engine.schedulePrewarmBiometricEngine()));
    expect(new Set(results).size).toBe(1);
    expect(readiness.ensureCalls).toBe(1);
  });

  it("web, Save-Data: does nothing in the background", async () => {
    Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    const { engine } = await load();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await engine.prewarmBiometricEngine()).toMatchObject({ platform: "web", mode: "skipped", reason: "save-data" });
    expect(readiness.ensureCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("web, low-memory device: caches assets but does not start the engine in the background", async () => {
    Object.defineProperty(navigator as Nav, "deviceMemory", { value: 2, configurable: true });
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ match: async () => undefined, put: async () => undefined, delete: async () => true, keys: async () => [] }),
      keys: async () => [],
      delete: async () => true,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const { engine } = await load();
    expect(await engine.prewarmBiometricEngine()).toMatchObject({ platform: "web", mode: "assets-only", reason: "low-memory" });
    expect(readiness.ensureCalls).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("web, capable device: prefetches then initializes the engine, without the camera", async () => {
    Object.defineProperty(navigator as Nav, "deviceMemory", { value: 8, configurable: true });
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ match: async () => undefined, put: async () => undefined, delete: async () => true, keys: async () => [] }),
      keys: async () => [],
      delete: async () => true,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const { engine } = await load();
    expect(await engine.prewarmBiometricEngine()).toMatchObject({ platform: "web", mode: "engine" });
    expect(readiness.ensureCalls).toBe(1);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
