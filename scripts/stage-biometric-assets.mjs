#!/usr/bin/env node
/**
 * Stage the biometric engine release for the web app and the native shells.
 *
 *   apps/web/public/biometric/<sha256[0..16]>/<file>      decoded bytes
 *   apps/web/public/biometric/<sha256[0..16]>/<file>.gz.bin   gzip -9 (network path;
 *     ".bin" so no server adds Content-Encoding, which would break Range requests)
 *   apps/web/public/biometric/release.json                 inventory
 *
 * Paths are content-addressed, so they are immutable and a JS bundle can
 * never be paired with a runtime or model from another release. Every staged
 * file must be pinned (same SHA-256) in the SDK release manifest
 * (packages/sdk/src/capture/biometric/model-manifest.ts); otherwise the build
 * fails instead of publishing bytes the engine would reject.
 *
 * The Capacitor shells package apps/web/dist, so the decoded files ship inside
 * the installed Android/iOS app and are served locally (no model download).
 *
 * Usage: node scripts/stage-biometric-assets.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(root, "apps/web/public/biometric");
const manifestSource = join(root, "packages/sdk/src/capture/biometric/model-manifest.ts");
const require = createRequire(import.meta.url);

function packageDir(name) {
  let dir = dirname(require.resolve(name));
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && JSON.parse(readFileSync(pj, "utf8")).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package ${name} not found`);
    dir = parent;
  }
}

const ortDist = join(packageDir("onnxruntime-web"), "dist");
const mpWasm = join(packageDir("@mediapipe/tasks-vision"), "wasm");
const models = join(root, "apps/web/public/models/trustid");

/** Must list the same files as BIOMETRIC_RELEASE_ASSETS. */
const SOURCES = [
  { id: "ort-wasm", path: join(ortDist, "ort-wasm-simd-threaded.wasm") },
  { id: "ort-loader", path: join(ortDist, "ort-wasm-simd-threaded.mjs") },
  { id: "mediapipe-loader-simd", path: join(mpWasm, "vision_wasm_internal.js") },
  { id: "mediapipe-loader-nosimd", path: join(mpWasm, "vision_wasm_nosimd_internal.js") },
  { id: "mediapipe-wasm-simd", path: join(mpWasm, "vision_wasm_internal.wasm") },
  { id: "mediapipe-wasm-nosimd", path: join(mpWasm, "vision_wasm_nosimd_internal.wasm") },
  { id: "face-landmarker", path: join(models, "face_landmarker.task") },
  { id: "arcface", path: join(models, "w600k_mbf.onnx") },
];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function pinnedHashes() {
  const text = readFileSync(manifestSource, "utf8");
  return new Set([...text.matchAll(/"([0-9a-f]{64})"/g)].map((m) => m[1]));
}

function main() {
  const pinned = pinnedHashes();
  mkdirSync(outRoot, { recursive: true });
  const inventory = [];
  const keep = new Set(["release.json"]);
  for (const src of SOURCES) {
    if (!existsSync(src.path)) throw new Error(`biometric asset source missing: ${src.path}`);
    const bytes = readFileSync(src.path);
    const digest = sha256(bytes);
    if (!pinned.has(digest)) {
      throw new Error(
        `${src.id}: ${src.path} has sha256 ${digest}, which the SDK release manifest does not pin. ` +
          "Update BIOMETRIC_RELEASE_ASSETS (and run the engine conformance tests) before publishing new bytes.",
      );
    }
    const dir = digest.slice(0, 16);
    const file = src.path.split(/[\\/]/).pop();
    keep.add(dir);
    const outDir = join(outRoot, dir);
    mkdirSync(outDir, { recursive: true });
    const rawOut = join(outDir, file);
    const gzOut = `${rawOut}.gz.bin`;
    if (!existsSync(rawOut) || statSync(rawOut).size !== bytes.byteLength || sha256(readFileSync(rawOut)) !== digest) {
      writeFileSync(rawOut, bytes);
    }
    if (!existsSync(gzOut)) writeFileSync(gzOut, gzipSync(bytes, { level: 9 }));
    const gzBytes = statSync(gzOut).size;
    inventory.push({
      id: src.id,
      file,
      sha256: digest,
      bytes: bytes.byteLength,
      gzipBytes: gzBytes,
      path: `biometric/${dir}/${file}`,
    });
    console.log(`staged ${src.id.padEnd(24)} ${String(bytes.byteLength).padStart(9)} B -> gzip ${String(gzBytes).padStart(9)} B  ${dir}`);
  }
  for (const name of readdirSync(outRoot)) {
    if (keep.has(name)) continue;
    rmSync(join(outRoot, name), { recursive: true, force: true });
    console.log(`removed stale biometric release dir: ${name}`);
  }
  writeFileSync(join(outRoot, "release.json"), `${JSON.stringify({ assets: inventory }, null, 2)}\n`);
  const total = (k) => inventory.reduce((n, a) => n + a[k], 0);
  console.log(`biometric release staged: ${inventory.length} assets, ${total("bytes")} B decoded, ${total("gzipBytes")} B gzip`);
}

main();
