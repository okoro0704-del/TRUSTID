// @vitest-environment node
/**
 * Release integrity and embedding-space conformance, on the real files:
 *  - every pinned SHA-256 equals the bytes actually installed / served;
 *  - the real ArcFace model on the real onnxruntime-web WASM reproduces the
 *    engine conformance vector;
 *  - bytes delivered gzip-encoded (web) and raw (app bundle) produce the
 *    identical embedding, so every platform shares one embedding space.
 *
 * Regenerate the golden only for a deliberate, evaluated model change:
 *   UPDATE_ENGINE_CONFORMANCE=1 npx vitest run tests/engine-conformance.test.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
} from "@trustid/shared";
import { describe, expect, it } from "vitest";
import {
  assessEngineConformance,
  conformanceTensor,
  ENGINE_CONFORMANCE_MIN_COSINE,
} from "../src/capture/biometric/engine-conformance.js";
import { ENGINE_CONFORMANCE_GOLDEN } from "../src/capture/biometric/engine-conformance-golden.js";
import {
  BIOMETRIC_ENGINE_RELEASE,
  BIOMETRIC_RELEASE_ASSETS,
  ORT_WEB_VERSION,
  type BiometricReleaseAssetId,
} from "../src/capture/biometric/model-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const require = createRequire(import.meta.url);

function packageDir(entry: string): string {
  let dir = dirname(require.resolve(entry));
  while (!existsSync(join(dir, "package.json")) || !readFileSync(join(dir, "package.json"), "utf8").includes(`"name": "${entry}"`)) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package ${entry} not found`);
    dir = parent;
  }
  return dir;
}

function sourceOf(id: BiometricReleaseAssetId): string {
  const ort = join(packageDir("onnxruntime-web"), "dist");
  const mp = join(packageDir("@mediapipe/tasks-vision"), "wasm");
  const models = join(repo, "apps/web/public/models/trustid");
  const file = BIOMETRIC_RELEASE_ASSETS[id].file;
  if (id.startsWith("ort-")) return join(ort, file);
  if (id.startsWith("mediapipe-")) return join(mp, file);
  return join(models, file);
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type OrtLike = {
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

async function embed(modelBytes: Uint8Array, input: Float32Array): Promise<Float32Array> {
  const mod = (await import("onnxruntime-web/wasm")) as unknown as { env?: unknown; default?: unknown };
  const ort = (mod.env ? mod : mod.default) as OrtLike;
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
  const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, 112, 112]) });
  const data = Float32Array.from(out[session.outputNames[0]!]!.data);
  await session.release();
  return data;
}

describe("biometric release integrity", () => {
  for (const id of Object.keys(BIOMETRIC_RELEASE_ASSETS) as BiometricReleaseAssetId[]) {
    it(`${id}: pinned SHA-256 and size equal the installed file`, () => {
      const bytes = readFileSync(sourceOf(id));
      expect(sha256(bytes)).toBe(BIOMETRIC_RELEASE_ASSETS[id].sha256);
      expect(bytes.byteLength).toBe(BIOMETRIC_RELEASE_ASSETS[id].bytes);
    });
  }

  it("the embedder in the release is the model the server matches against", () => {
    // Swapping the model file without bumping BIOMETRIC_AI_MODEL_VERSION would
    // silently mix embedding spaces; this pin makes that a failing change.
    expect(BIOMETRIC_ENGINE_RELEASE.embedder).toMatchObject({
      modelName: BIOMETRIC_AI_MODEL_NAME,
      modelVersion: BIOMETRIC_AI_MODEL_VERSION,
      sha256: "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f",
      dimensions: 512,
    });
    expect(BIOMETRIC_ENGINE_RELEASE.releaseId).toMatch(/^e2(-[0-9a-f]{6}){8}$/);
  });
});

describe("engine conformance vector", () => {
  const modelBytes = new Uint8Array(readFileSync(sourceOf("arcface")));

  it("the real model on the real WASM runtime reproduces the golden embedding", async () => {
    const out = await embed(modelBytes, conformanceTensor());
    expect(out.length).toBe(512);
    if (process.env.UPDATE_ENGINE_CONFORMANCE === "1") {
      let sum = 0;
      for (const v of out) sum += v * v;
      const norm = Math.sqrt(sum);
      const values = Array.from(out, (v) => Number((v / norm).toFixed(7)));
      const body =
        `// Generated by tests/engine-conformance.test.ts (UPDATE_ENGINE_CONFORMANCE=1). Do not edit.\n` +
        `// L2-normalized output of the reference engine on conformanceTensor().\n` +
        `export const ENGINE_CONFORMANCE_GOLDEN = {\n` +
        `  modelSha256: "${BIOMETRIC_RELEASE_ASSETS.arcface.sha256}",\n` +
        `  ortWebVersion: "${ORT_WEB_VERSION}",\n` +
        `  embedding: [\n${values.map((v) => `    ${v},`).join("\n")}\n  ] as number[],\n` +
        `} as const;\n`;
      writeFileSync(join(here, "../src/capture/biometric/engine-conformance-golden.ts"), body);
      return;
    }
    expect(ENGINE_CONFORMANCE_GOLDEN.modelSha256).toBe(BIOMETRIC_RELEASE_ASSETS.arcface.sha256);
    const result = assessEngineConformance(out);
    expect(result.cosine).toBeGreaterThanOrEqual(ENGINE_CONFORMANCE_MIN_COSINE);
    expect(result.maxAbsDiff).toBeLessThan(1e-4);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("gzip (web) and raw (app bundle) delivery give the identical model and the identical embedding", async () => {
    const viaGzip = new Uint8Array(gunzipSync(gzipSync(modelBytes, { level: 9 })));
    expect(sha256(viaGzip)).toBe(sha256(modelBytes));
    const a = await embed(modelBytes, conformanceTensor());
    const b = await embed(viaGzip, conformanceTensor());
    expect(Array.from(a)).toEqual(Array.from(b));
  }, 60_000);

  it("preprocessing mistakes are caught: BGR order, mirrored crop, wrong pixel scale", async () => {
    const plane = 112 * 112;
    const t = conformanceTensor();
    const bgr = new Float32Array(t.length);
    bgr.set(t.subarray(2 * plane, 3 * plane), 0);
    bgr.set(t.subarray(plane, 2 * plane), plane);
    bgr.set(t.subarray(0, plane), 2 * plane);
    const mirrored = new Float32Array(t.length);
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < 112; y++)
        for (let x = 0; x < 112; x++) mirrored[c * plane + y * 112 + x] = t[c * plane + y * 112 + (111 - x)]!;
    // [0,1] scaling instead of (x-127.5)/128.
    const scaled = t.map((v) => (v * 128 + 127.5) / 255);
    for (const wrong of [bgr, mirrored, scaled]) {
      const r = assessEngineConformance(await embed(modelBytes, wrong));
      expect(r.ok).toBe(false);
      expect(r.cosine).toBeLessThan(0.99);
    }
  }, 120_000);
});
