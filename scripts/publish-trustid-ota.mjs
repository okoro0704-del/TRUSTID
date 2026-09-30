/**
 * Publish the built TrustID Android APK to the Netlify OTA channel.
 *
 *   node scripts/publish-trustid-ota.mjs [path/to/app.apk]
 *
 * Copies the APK to apps/web/public/releases/TrustID.apk and writes
 * apps/web/public/releases/trustid-android.json from the *copied* bytes, after
 * checking package name, versionCode/versionName (apps/device/release.json) and
 * signer with the Android SDK's own tools. Never rebuild after running this: the
 * manifest hash is bound to these exact bytes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(readFileSync(join(root, "apps/device/release.json"), "utf8"));
const source = resolve(process.argv[2] ?? join(root, "apps/device/android/app/build/outputs/apk/debug/app-debug.apk"));
const releasesDir = join(root, "apps/web/public/releases");
const apkName = "TrustID.apk";
const manifestName = "trustid-android.json";

function fail(message) {
  console.error(`publish-trustid-ota: ${message}`);
  process.exit(1);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function buildTools() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
  const dir = join(sdk, "build-tools");
  if (!existsSync(dir)) fail(`Android build-tools not found under ${sdk}`);
  const versions = readdirSync(dir)
    .filter((v) => existsSync(join(dir, v, process.platform === "win32" ? "apksigner.bat" : "apksigner")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) fail("no build-tools version with apksigner");
  return join(dir, versions[versions.length - 1]);
}

function run(tool, args) {
  const isBat = tool.endsWith(".bat");
  return execFileSync(isBat ? "cmd.exe" : tool, isBat ? ["/c", tool, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function inspectApk(apk) {
  const tools = buildTools();
  const exe = process.platform === "win32" ? ".exe" : "";
  const badging = run(join(tools, `aapt2${exe}`), ["dump", "badging", apk]);
  const pkg = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m);
  if (!pkg) fail("could not read package identity from APK");
  const minSdk = badging.match(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m);

  const certs = run(join(tools, process.platform === "win32" ? "apksigner.bat" : "apksigner"), [
    "verify",
    "--print-certs",
    apk,
  ]);
  const signers = [...certs.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$/gm)].map((m) => m[1]);
  if (!signers.length) fail("APK signature did not verify / no signer found");
  return {
    applicationId: pkg[1],
    versionCode: Number(pkg[2]),
    versionName: pkg[3],
    minSdk: minSdk ? Number(minSdk[1]) : 1,
    signerSha256: [...new Set(signers)],
  };
}

if (!existsSync(source)) fail(`APK not found: ${source}`);
if (readFileSync(source).includes(Buffer.from("assets/public/releases/"))) {
  fail("APK embeds public/releases (a previous OTA APK); rebuild the device web bundle");
}

const identity = inspectApk(source);
for (const key of ["applicationId", "versionCode", "versionName"]) {
  if (identity[key] !== release[key]) {
    fail(`${key} mismatch: APK=${identity[key]} release.json=${release[key]}`);
  }
}

const manifestUrl = new URL(release.otaManifestUrl);
if (manifestUrl.protocol !== "https:") fail("otaManifestUrl must be https");

mkdirSync(releasesDir, { recursive: true });
const published = join(releasesDir, apkName);
copyFileSync(source, published);

const apkSha256 = sha256(published);
if (apkSha256 !== sha256(source)) fail("published APK differs from the built APK");
const apkSize = statSync(published).size;

const manifest = {
  schema: "trustid.android-ota.v1",
  applicationId: identity.applicationId,
  channel: release.channel,
  releaseId: `trustid-android-${identity.versionName}-${identity.versionCode}-${apkSha256.slice(0, 12)}`,
  versionName: identity.versionName,
  versionCode: identity.versionCode,
  publishedAt: new Date().toISOString(),
  apkUrl: new URL(`/releases/${apkName}`, manifestUrl.origin).toString(),
  apkSha256,
  apkSize,
  signerSha256: identity.signerSha256,
  minSdk: identity.minSdk,
};
writeFileSync(join(releasesDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, published, manifest }, null, 2));
