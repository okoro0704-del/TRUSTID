/**
 * The one biometric engine contract: explicit infrastructure states, engine
 * readiness kept separate from network/identification availability, and a
 * prefetch that never touches the camera.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  biometricEngineStatusFromReadiness,
  describeBiometricEngineStatus,
  prefetchBiometricAssets,
  WasmBiometricEngine,
} from "../src/capture/biometric/biometric-engine.js";
import { configureBiometricDelivery, resetBiometricDeliveryForTests } from "../src/capture/biometric/asset-delivery.js";
import { reportAssetProgress, resetAssetProgressForTests } from "../src/capture/biometric/asset-progress.js";
import type {
  BiometricComponentReport,
  BiometricReadinessSnapshot,
} from "../src/capture/biometric/biometric-readiness.js";
import { BIOMETRIC_ENGINE_RELEASE, BIOMETRIC_RELEASE_ASSETS, biometricAssetDir } from "../src/capture/biometric/model-manifest.js";

function report(state: BiometricComponentReport["state"], extra: Partial<BiometricComponentReport> = {}): BiometricComponentReport {
  return {
    state,
    attempts: state === "IDLE" ? 0 : 1,
    durationMs: state === "READY" ? 12 : null,
    assetUrl: null,
    bytesLoaded: null,
    bytesTotal: null,
    fromCache: null,
    failureCategory: null,
    error: null,
    ...extra,
  };
}

function snap(partial: Partial<BiometricReadinessSnapshot>): BiometricReadinessSnapshot {
  return {
    stage: "IDLE",
    ready: false,
    failed: false,
    loading: false,
    requiresReload: false,
    runtime: report("IDLE"),
    detector: report("IDLE"),
    embedder: report("IDLE"),
    warmup: report("IDLE"),
    transitions: [],
    passes: 0,
    ...partial,
  };
}

const loading = () =>
  snap({ loading: true, runtime: report("LOADING"), detector: report("LOADING"), embedder: report("LOADING") });

beforeEach(() => {
  resetAssetProgressForTests();
  resetBiometricDeliveryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("engine state", () => {
  it("PREPARING before any asset reports progress", () => {
    expect(biometricEngineStatusFromReadiness(loading(), "web").state).toBe("PREPARING");
  });

  it("DOWNLOADING counts only network bytes, never cached or bundled ones", () => {
    reportAssetProgress("arcface", { url: "n", loaded: 4_000_000, total: 12_000_000, fromCache: false, source: "network", phase: "downloading" });
    reportAssetProgress("ort-wasm", { url: "c", loaded: 12_666_427, total: 12_666_427, fromCache: true, source: "cache", phase: "ready" });
    const s = biometricEngineStatusFromReadiness(loading(), "web");
    expect(s.state).toBe("DOWNLOADING");
    expect(s.download).toEqual({ loaded: 4_000_000, total: 12_000_000 });
    expect(s.assetSource).toBe("mixed");
    expect(describeBiometricEngineStatus(s)).toBe("Downloading face recognition (3.8 of 11.4 MB)");
  });

  it("an installed app never reports a download: VERIFYING, then INITIALIZING", () => {
    for (const id of ["ort-wasm", "mediapipe-wasm", "face-landmarker"] as const) {
      reportAssetProgress(id, { url: "b", loaded: 0, total: 0, fromCache: true, source: "app-bundle", phase: "ready" });
    }
    reportAssetProgress("arcface", { url: "b", loaded: 0, total: 0, fromCache: true, source: "app-bundle", phase: "verifying" });
    const verifying = biometricEngineStatusFromReadiness(loading(), "android");
    expect(verifying.state).toBe("VERIFYING");
    expect(verifying.download).toBeNull();

    reportAssetProgress("arcface", { url: "b", loaded: 0, total: 0, fromCache: true, source: "app-bundle", phase: "ready" });
    const init = biometricEngineStatusFromReadiness(loading(), "android");
    expect(init).toMatchObject({ state: "INITIALIZING", assetSource: "app-bundle", download: null, platform: "android" });
    expect(describeBiometricEngineStatus(init)).not.toMatch(/MB|Download/);
  });

  it("WARMING_UP while the conformance warm-up runs, READY after", () => {
    const warming = snap({ loading: true, runtime: report("READY"), detector: report("READY"), embedder: report("READY"), warmup: report("LOADING") });
    expect(biometricEngineStatusFromReadiness(warming, "web").state).toBe("WARMING_UP");
    const ready = snap({ stage: "BIOMETRIC_READY", ready: true, runtime: report("READY"), detector: report("READY"), embedder: report("READY"), warmup: report("READY") });
    const s = biometricEngineStatusFromReadiness(ready, "web");
    expect(s.state).toBe("READY");
    expect(s.releaseId).toBe(BIOMETRIC_ENGINE_RELEASE.releaseId);
    expect(s.embedder.sha256).toBe(BIOMETRIC_RELEASE_ASSETS.arcface.sha256);
    expect(s.timingsMs).toMatchObject({ runtime: 12, detector: 12, embedder: 12, warmup: 12 });
  });

  it("an infrastructure failure is FAILED with its category, never a match result", () => {
    const failed = snap({
      stage: "EMBEDDER_FAILED",
      failed: true,
      // The last snapshot of a pass is taken while the pass is still in flight.
      loading: true,
      requiresReload: true,
      runtime: report("READY"),
      detector: report("READY"),
      embedder: report("FAILED", { failureCategory: "ASSET_MISSING" }),
    });
    const s = biometricEngineStatusFromReadiness(failed, "web");
    expect(s).toMatchObject({
      state: "FAILED",
      BIOMETRIC_ENGINE_READY: false,
      IDENTIFICATION_AVAILABLE: false,
      failure: { component: "embedder", category: "ASSET_MISSING", requiresReload: true },
    });
    expect(describeBiometricEngineStatus(s)).not.toMatch(/match/i);
  });
});

describe("engine vs network vs identification", () => {
  const ready = () =>
    snap({ stage: "BIOMETRIC_READY", ready: true, runtime: report("READY"), detector: report("READY"), embedder: report("READY"), warmup: report("READY") });

  it("offline: the engine is ready but identification is not available", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const s = biometricEngineStatusFromReadiness(ready(), "android");
    expect(s).toMatchObject({
      BIOMETRIC_ENGINE_READY: true,
      IDENTITY_NETWORK_AVAILABLE: false,
      IDENTIFICATION_AVAILABLE: false,
    });
    expect(describeBiometricEngineStatus(s)).toBe("Face recognition ready · offline");
  });

  it("online and ready: identification is available", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(biometricEngineStatusFromReadiness(ready(), "web").IDENTIFICATION_AVAILABLE).toBe(true);
  });
});

describe("prefetch is not a scan", () => {
  it("never opens the camera", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ match: async () => undefined, put: async () => undefined, delete: async () => true, keys: async () => [] }),
      keys: async () => [],
      delete: async () => true,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const result = await prefetchBiometricAssets();
    expect(result.status).toBe("failed");
    expect(getUserMedia).not.toHaveBeenCalled();
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("skips when the user asked to save data", async () => {
    Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await prefetchBiometricAssets()).toMatchObject({ status: "skipped", reason: "save-data" });
    expect(fetchSpy).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "connection", { value: undefined, configurable: true });
  });

  it("skips on an installed app that already carries the release", async () => {
    (globalThis as { caches?: unknown }).caches = { open: async () => ({}), keys: async () => [], delete: async () => true };
    configureBiometricDelivery({
      nativeBridge: {
        getBundle: async () => ({
          apiVersion: 1,
          baseUrl: "/__trustid_native__/",
          assets: Object.values(BIOMETRIC_RELEASE_ASSETS).map((a) => biometricAssetDir(a)),
        }),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await prefetchBiometricAssets()).toMatchObject({ status: "skipped", reason: "app-bundle" });
    expect(fetchSpy).not.toHaveBeenCalled();
    delete (globalThis as { caches?: unknown }).caches;
  });
});

describe("engine contract", () => {
  it("closeCamera stops every track", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const engine = new WasmBiometricEngine("web");
    await engine.openCamera();
    engine.closeCamera();
    expect(stop).toHaveBeenCalledTimes(2);
    engine.dispose();
  });
});
