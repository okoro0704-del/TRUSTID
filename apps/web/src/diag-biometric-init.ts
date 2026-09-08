/**
 * Dev-only page: /diag-biometric.html
 * Isolates MediaPipe vs ArcFace initialization with TRUSTID_FACE_CAPTURE_DIAG.
 * Does not capture camera frames or log biometric material.
 */
import { aiVectorExtractor } from "@trustid/sdk";

declare global {
  interface Window {
    __TRUSTID_FACE_CAPTURE_DIAG__?: boolean;
    __TRUSTID_DIAG_RESULT__?: Record<string, unknown>;
  }
}

const out = document.getElementById("out");
const lines: string[] = [];

function log(line: string) {
  lines.push(line);
  if (out) out.textContent = lines.join("\n");
  console.info("[diag]", line);
}

const origInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (text.includes("face_capture_diag") || text.includes("[TrustID]")) {
    lines.push(text);
    if (out) out.textContent = lines.join("\n");
  }
  origInfo(...args);
};

async function main() {
  try {
    localStorage.setItem("TRUSTID_FACE_CAPTURE_DIAG", "1");
  } catch {
    /* ignore */
  }
  window.__TRUSTID_FACE_CAPTURE_DIAG__ = true;

  log("model_paths=/models/trustid/face_landmarker.task,/models/trustid/w600k_mbf.onnx");

  const headLandmarker = await fetch("/models/trustid/face_landmarker.task", {
    method: "HEAD",
  });
  const headOnnx = await fetch("/models/trustid/w600k_mbf.onnx", { method: "HEAD" });
  log(`artifact_head landmarker=${headLandmarker.status} onnx=${headOnnx.status}`);

  const started = performance.now();
  const extractor = await aiVectorExtractor.getShared({
    modelBaseUrl: "/models/trustid",
    // Use production default warm-up budget (do not inflate for diag).
  });
  const ms = Math.round(performance.now() - started);

  const summary = {
    ready: extractor.isReady(),
    lastError: extractor.getLastError(),
    ms,
  };
  window.__TRUSTID_DIAG_RESULT__ = summary;
  log(`final_extractor ready=${summary.ready} ms=${ms}`);
  if (summary.lastError) log(`final_error=${summary.lastError}`);
}

main().catch((err) => {
  log(`fatal=${err instanceof Error ? err.message : String(err)}`);
  window.__TRUSTID_DIAG_RESULT__ = {
    ready: false,
    lastError: err instanceof Error ? err.message : String(err),
  };
});
