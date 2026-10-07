/**
 * Dev-only page: /diag-engine.html
 * Initializes the biometric engine (runtime, detector, embedder, conformance
 * warm-up) and reports timings, asset sources and engine status. Never opens
 * the camera and never handles biometric material.
 */
import { getBiometricEngine, getBiometricReadiness, getBiometricRuntimeStatus } from "@trustid/sdk";

declare global {
  interface Window {
    __TRUSTID_ENGINE_RESULT__?: Record<string, unknown>;
  }
}

const out = document.getElementById("out");
const started = performance.now();
const engine = getBiometricEngine();
const states: Array<{ t: number; state: string }> = [];
engine.subscribe((s) => {
  if (states[states.length - 1]?.state !== s.state) states.push({ t: Math.round(performance.now() - started), state: s.state });
});

void engine.initialize().then((status) => {
  const snap = getBiometricReadiness();
  const runtime = getBiometricRuntimeStatus().runtime;
  const result = {
    loaderIntegrity: runtime.loaderIntegrity,
    runtimeInitAttempts: runtime.runtimeInitAttempts,
    totalMs: Math.round(performance.now() - started),
    state: status.state,
    assetSource: status.assetSource,
    releaseId: status.releaseId,
    timingsMs: status.timingsMs,
    flags: {
      BIOMETRIC_ENGINE_READY: status.BIOMETRIC_ENGINE_READY,
      IDENTITY_NETWORK_AVAILABLE: status.IDENTITY_NETWORK_AVAILABLE,
      IDENTIFICATION_AVAILABLE: status.IDENTIFICATION_AVAILABLE,
    },
    failure: status.failure,
    errors: [snap.runtime.error, snap.detector.error, snap.embedder.error, snap.warmup.error].filter(Boolean),
    states,
  };
  window.__TRUSTID_ENGINE_RESULT__ = result;
  if (out) out.textContent = JSON.stringify(result, null, 2);
});

/**
 * ?scan=1: time camera -> first face -> quality -> embedding through the
 * engine contract. Reports timings and result codes only. The embedding is
 * zeroed immediately and never leaves this page; no identification request is
 * made, and PAD is skipped because no identity decision is taken here.
 */
type ScanTimings = Record<string, number | string | null>;

async function scanOnce(): Promise<ScanTimings> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const out: ScanTimings = { cameraReadyMs: null, firstFaceMs: null, qualityPassMs: null, embeddingMs: null, framesTried: 0, lastReason: null };
  const session = await engine.openCamera();
  out.cameraReadyMs = ms();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  try {
    for (let i = 0; i < 150 && out.embeddingMs == null; i++) {
      await new Promise((r) => setTimeout(r, 66));
      const v = session.video;
      if (!v.videoWidth) continue;
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      ctx.drawImage(v, 0, 0);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      out.framesTried = (out.framesTried as number) + 1;
      const detectStart = performance.now();
      const detection = await engine.detectFace(frame);
      out.lastDetectMs = Math.round(performance.now() - detectStart);
      if (detection.faces.length && out.firstFaceMs == null) out.firstFaceMs = ms();
      const candidate = engine.evaluateQuality(frame, detection);
      if (!candidate.ok) {
        out.lastReason = candidate.reason ?? candidate.code;
        continue;
      }
      if (out.qualityPassMs == null) out.qualityPassMs = ms();
      const embedStart = performance.now();
      const res = await engine.createEmbedding(frame, candidate, { skipPad: true });
      if (res.ok) {
        res.payload.vector.fill(0);
        out.embeddingMs = Math.round(performance.now() - embedStart);
        out.embeddingReadyMs = ms();
        out.dims = res.payload.vector.length;
      } else {
        out.lastReason = res.reason ?? res.code;
      }
      frame.data.fill(0);
    }
  } finally {
    engine.closeCamera();
    canvas.width = 0;
  }
  return out;
}

if (new URLSearchParams(location.search).get("scan") === "1") {
  void engine.initialize().then(async (status) => {
    if (status.state !== "READY") return;
    const scan = await scanOnce().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    (window as Window & { __TRUSTID_SCAN_RESULT__?: unknown }).__TRUSTID_SCAN_RESULT__ = scan;
    if (out) out.textContent += `\n\nscan: ${JSON.stringify(scan, null, 2)}`;
  });
}
