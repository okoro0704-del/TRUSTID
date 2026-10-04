#!/usr/bin/env node
/**
 * Serve MediaPipe WASM from the TrustID origin for iOS Safari reliability.
 *
 * Files go to apps/web/public/mediapipe/<@mediapipe/tasks-vision version>/,
 * which must equal MEDIAPIPE_TASKS_VISION_VERSION in the SDK model manifest.
 * A new version gets a new path, so a JS bundle is never paired with a loader
 * or binary from another release.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(root, "../node_modules/@mediapipe/tasks-vision");
const source = join(pkgDir, "wasm");
const mediapipeRoot = join(root, "../apps/web/public/mediapipe");
const files = ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"];

if (!existsSync(source)) throw new Error(`MediaPipe WASM source missing: ${source}`);
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const destination = join(mediapipeRoot, version);
mkdirSync(destination, { recursive: true });

// Generated folder: drop other versions so stale runtimes are never published.
for (const name of readdirSync(mediapipeRoot)) {
  if (name === version || !/^\d+\.\d+\.\d+/.test(name)) continue;
  rmSync(join(mediapipeRoot, name), { recursive: true, force: true });
  console.log(`removed stale MediaPipe asset: ${name}`);
}

// Bundles built before versioned paths load /mediapipe/wasm/. Keep serving it
// so a client still running a precached older bundle does not lose its detector.
const legacyDestination = join(mediapipeRoot, "wasm");
mkdirSync(legacyDestination, { recursive: true });

const available = new Set(readdirSync(source));
for (const file of files) {
  if (!available.has(file)) throw new Error(`MediaPipe WASM asset missing: ${file}`);
  copyFileSync(join(source, file), join(destination, file));
  copyFileSync(join(source, file), join(legacyDestination, file));
  console.log(`copied ${file}`);
}
console.log(`MediaPipe ${version} wasm assets ready at ${destination}`);
