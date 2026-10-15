#!/usr/bin/env node
/**
 * Check a built TrustID APK before it is distributed or tested:
 *   - package name is the expected one (com.trustid.device / com.trustid.device.staging),
 *   - the app is not debuggable,
 *   - the bundled web shell loads the expected origin (capacitor.config.json server.url),
 *   - backup / device transfer are disabled,
 *   - optionally, it is signed by exactly the expected certificate (SHA-256).
 *
 * usage: node scripts/verify-android-apk.mjs <apk> --package <id> --origin <https origin> [--signer <sha256 hex>]
 * Needs Android build-tools (ANDROID_HOME / ANDROID_SDK_ROOT, or the default SDK location) and unzip.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function buildTools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : "");
  const dir = join(sdk, "build-tools");
  if (!sdk || !existsSync(dir)) throw new Error("Android build-tools not found (set ANDROID_HOME)");
  const latest = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const win = process.platform === "win32";
  return { aapt2: join(dir, latest, win ? "aapt2.exe" : "aapt2"), apksigner: join(dir, latest, win ? "apksigner.bat" : "apksigner") };
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: cmd.endsWith(".bat") });

const apk = process.argv[2];
const expectedPackage = arg("package");
const expectedOrigin = arg("origin");
const expectedSigner = arg("signer")?.toLowerCase().replace(/:/g, "");
if (!apk || !expectedPackage || !expectedOrigin) {
  console.error("usage: verify-android-apk.mjs <apk> --package <id> --origin <https origin> [--signer <sha256>]");
  process.exit(2);
}

const failures = [];
const tools = buildTools();

const badging = run(tools.aapt2, ["dump", "badging", apk]);
const pkg = badging.match(/^package: name='([^']+)'/m)?.[1];
if (pkg !== expectedPackage) failures.push(`package is ${pkg}, expected ${expectedPackage}`);

const manifest = run(tools.aapt2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apk]);
// aapt2 prints booleans as "=true" / "=false" (older aapt: "=(type 0x12)0xffffffff").
const attr = (name) => manifest.match(new RegExp(`android:${name}\\([^)]*\\)=(?:\\(type [^)]*\\))?(\\S+)`))?.[1];
const truthy = (v) => v !== undefined && v !== "false" && v !== "0x0";
const debuggable = truthy(attr("debuggable"));
if (debuggable) failures.push("APK is debuggable");
const backupAllowed = attr("allowBackup") === undefined || truthy(attr("allowBackup"));
if (backupAllowed) failures.push("android:allowBackup is not false");
if (!/android:dataExtractionRules/.test(manifest)) failures.push("android:dataExtractionRules missing (device transfer not excluded)");

const capConfig = JSON.parse(execFileSync("unzip", ["-p", apk, "assets/capacitor.config.json"], { encoding: "utf8" }));
if (capConfig?.server?.url !== expectedOrigin) failures.push(`web shell loads ${capConfig?.server?.url ?? "bundled assets"}, expected ${expectedOrigin}`);

let signer = "unsigned";
try {
  const certs = run(tools.apksigner, ["verify", "--print-certs", apk]);
  const digests = [...certs.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => m[1]);
  signer = digests.join(",") || "unknown";
  if (expectedSigner && (digests.length !== 1 || digests[0] !== expectedSigner)) failures.push(`signed by ${signer}, expected ${expectedSigner}`);
} catch {
  if (expectedSigner) failures.push("APK is not signed");
}

console.log(`package=${pkg} debuggable=${debuggable} allowBackup=${backupAllowed} origin=${capConfig?.server?.url} signer=${signer}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("APK identity verified");
