#!/usr/bin/env node
/**
 * Copy the onnxruntime-web WASM-only runtime into
 * apps/web/public/ort/<onnxruntime-web version>/ so ArcFace loads same-origin
 * (no CDN flake / CORS / COOP issues).
 *
 * The SDK imports "onnxruntime-web/wasm" and resolves assets from
 * /ort/<env.versions.web>/, so the folder name must equal the installed
 * package version. A new version gets a new path, which keeps the immutable
 * cache headers on /ort/* from ever pairing new JS with an old binary.
 *
 * Usage: node scripts/copy-ort-wasm.mjs
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ortRoot = join(__dirname, "../apps/web/public/ort");
const require = createRequire(import.meta.url);

const NEEDED = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

function resolveOrtPackage() {
  // package.json is not in "exports"; resolve a public entry then walk up.
  const entry = require.resolve("onnxruntime-web");
  let dir = dirname(entry);
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not locate onnxruntime-web from ${entry}`);
    dir = parent;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const dist = join(dir, "dist");
  if (!existsSync(join(dist, NEEDED[0]))) {
    throw new Error(`onnxruntime-web dist not found at ${dist}`);
  }
  return { version: pkg.version, dist };
}

function main() {
  const { version, dist } = resolveOrtPackage();
  const outDir = join(ortRoot, version);
  mkdirSync(outDir, { recursive: true });

  // public/ort is generated (gitignored): drop other versions and the old
  // unversioned layout so stale runtimes are never published.
  for (const name of readdirSync(ortRoot)) {
    if (name === version) continue;
    rmSync(join(ortRoot, name), { recursive: true, force: true });
    console.log(`removed stale ORT asset: ${name}`);
  }

  const available = new Set(readdirSync(dist));
  for (const name of NEEDED) {
    if (!available.has(name)) {
      throw new Error(`missing ORT asset: ${name}`);
    }
    copyFileSync(join(dist, name), join(outDir, name));
    console.log(`copied ${name}`);
  }
  console.log(`ORT ${version} wasm assets ready at ${outDir}`);
}

main();
