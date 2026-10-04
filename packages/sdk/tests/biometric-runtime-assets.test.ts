// @vitest-environment node
/**
 * Checks against the real installed packages: the runtime probe model runs on
 * the real onnxruntime-web WASM build, and the versions the web app serves
 * under /ort/<v>/ and /mediapipe/<v>/ match what is installed.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORT_RUNTIME_PROBE_MODEL } from "../src/capture/biometric/ort-runtime.js";
import {
  MEDIAPIPE_TASKS_VISION_VERSION,
  MEDIAPIPE_WASM_BASE,
  ORT_WEB_VERSION,
} from "../src/capture/biometric/model-manifest.js";

const require = createRequire(import.meta.url);

function packageVersion(entry: string): string {
  let dir = dirname(require.resolve(entry));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version: string };
      if (pkg.name && entry.startsWith(pkg.name)) return pkg.version;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json for ${entry} not found`);
    dir = parent;
  }
}

describe("biometric runtime assets", () => {
  it("pinned ORT version equals the installed onnxruntime-web", () => {
    expect(ORT_WEB_VERSION).toBe(packageVersion("onnxruntime-web"));
  });

  it("pinned MediaPipe version equals the installed @mediapipe/tasks-vision", () => {
    expect(MEDIAPIPE_TASKS_VISION_VERSION).toBe(packageVersion("@mediapipe/tasks-vision"));
    expect(MEDIAPIPE_WASM_BASE).toBe(`/mediapipe/${MEDIAPIPE_TASKS_VISION_VERSION}`);
  });

  it("the runtime probe model initializes and runs on the real ORT WASM runtime", async () => {
    const mod = (await import("onnxruntime-web/wasm")) as unknown as {
      default?: unknown;
      env?: unknown;
    };
    const ort = (mod.env ? mod : mod.default) as {
      env: { wasm: { numThreads: number } };
      InferenceSession: {
        create: (m: Uint8Array, o: unknown) => Promise<{
          inputNames: string[];
          outputNames: string[];
          run: (f: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
          release: () => Promise<void>;
        }>;
      };
      Tensor: new (t: string, d: Float32Array, dims: number[]) => unknown;
    };
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(ORT_RUNTIME_PROBE_MODEL, {
      executionProviders: ["wasm"],
    });
    expect(session.inputNames).toEqual(["x"]);
    expect(session.outputNames).toEqual(["y"]);
    const out = await session.run({ x: new ort.Tensor("float32", Float32Array.from([0.5]), [1]) });
    expect(Array.from(out.y!.data)).toEqual([0.5]);
    await session.release();
  }, 30_000);
});
