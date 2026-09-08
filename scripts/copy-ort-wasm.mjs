#!/usr/bin/env node
/**
 * Copy onnxruntime-web WASM/JS assets into apps/web/public/ort/
 * so ArcFace can load same-origin (no CDN flake / CORS / COOP issues).
 *
 * Usage: node scripts/copy-ort-wasm.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../apps/web/public/ort");
const require = createRequire(import.meta.url);

const NEEDED = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

function resolveOrtDist() {
  // package.json is not in "exports"; resolve a public entry then walk to dist/.
  const entry = require.resolve("onnxruntime-web");
  // e.g. .../onnxruntime-web/dist/ort.mjs or similar
  const dist = dirname(entry);
  if (existsSync(join(dist, "ort-wasm-simd-threaded.mjs"))) return dist;
  const alt = join(dirname(dist), "dist");
  if (existsSync(join(alt, "ort-wasm-simd-threaded.mjs"))) return alt;
  throw new Error(`Could not locate onnxruntime-web dist from ${entry}`);
}

function main() {
  const dist = resolveOrtDist();
  if (!existsSync(dist)) {
    throw new Error(`onnxruntime-web dist not found at ${dist}`);
  }
  mkdirSync(outDir, { recursive: true });

  const available = new Set(readdirSync(dist));
  for (const name of NEEDED) {
    if (!available.has(name)) {
      console.warn(`skip missing ORT asset: ${name}`);
      continue;
    }
    const dest = join(outDir, name);
    copyFileSync(join(dist, name), dest);
    console.log(`copied ${name}`);
  }
  console.log(`ORT wasm assets ready at ${outDir}`);
}

main();
