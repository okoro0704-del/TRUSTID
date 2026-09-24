#!/usr/bin/env node
/** Serve MediaPipe WASM from the TrustID origin for iOS Safari reliability. */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "../node_modules/@mediapipe/tasks-vision/wasm");
const destination = join(root, "../apps/web/public/mediapipe/wasm");
const files = ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"];

if (!existsSync(source)) throw new Error(`MediaPipe WASM source missing: ${source}`);
mkdirSync(destination, { recursive: true });
const available = new Set(readdirSync(source));
for (const file of files) {
  if (!available.has(file)) throw new Error(`MediaPipe WASM asset missing: ${file}`);
  copyFileSync(join(source, file), join(destination, file));
  console.log(`copied ${file}`);
}
