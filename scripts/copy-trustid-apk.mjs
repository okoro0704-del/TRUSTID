/**
 * Copy the debug APK to a stable path the user can always reinstall from.
 * Target: <repo>/TrustID-debug.apk
 *
 * The OTA channel copy (apps/web/public/releases/TrustID.apk) is written only by
 * scripts/publish-trustid-ota.mjs, together with its manifest.
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(
  root,
  "apps/device/android/app/build/outputs/apk/debug/app-debug.apk",
);
const stable = join(root, "TrustID-debug.apk");

if (!existsSync(built)) {
  console.error(`APK not found: ${built}`);
  process.exit(1);
}

copyFileSync(built, stable);

console.log(JSON.stringify({ ok: true, stable }, null, 2));
