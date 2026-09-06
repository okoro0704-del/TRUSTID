/**
 * Copy the debug APK to a stable path the user can always reinstall from.
 * Target: <repo>/TrustID-debug.apk
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(
  root,
  "apps/device/android/app/build/outputs/apk/debug/app-debug.apk",
);
const stable = join(root, "TrustID-debug.apk");
const artifactDir = join(root, "artifacts/apk");
const artifact = join(artifactDir, "TrustID-debug.apk");

if (!existsSync(built)) {
  console.error(`APK not found: ${built}`);
  process.exit(1);
}

copyFileSync(built, stable);
mkdirSync(artifactDir, { recursive: true });
copyFileSync(built, artifact);

console.log(JSON.stringify({ ok: true, stable, artifact }, null, 2));
