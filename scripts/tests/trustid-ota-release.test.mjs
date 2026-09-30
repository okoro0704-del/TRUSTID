import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const release = JSON.parse(readFileSync(join(root, "apps/device/release.json"), "utf8"));
const releasesDir = join(root, "apps/web/public/releases");
const manifestPath = join(releasesDir, "trustid-android.json");
const apkPath = join(releasesDir, "TrustID.apk");
const HEX64 = /^[0-9a-f]{64}$/;

test("release.json is the single native version source", () => {
  assert.equal(release.applicationId, "com.trustid.device");
  assert.ok(Number.isInteger(release.versionCode) && release.versionCode > 1);
  assert.match(release.versionName, /^\d+\.\d+(\.\d+)?$/);
  assert.equal(new URL(release.otaManifestUrl).protocol, "https:");

  const gradle = readFileSync(join(root, "apps/device/android/app/build.gradle"), "utf8");
  assert.match(gradle, /release\.json/);
  assert.doesNotMatch(gradle, /versionCode\s+\d+/, "build.gradle must not hardcode versionCode");
  assert.doesNotMatch(gradle, /versionName\s+"/, "build.gradle must not hardcode versionName");
});

test("published OTA manifest matches the committed APK byte-for-byte", () => {
  assert.ok(existsSync(manifestPath), "manifest missing");
  assert.ok(existsSync(apkPath), "APK missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.schema, "trustid.android-ota.v1");
  assert.equal(manifest.applicationId, release.applicationId);
  assert.equal(manifest.versionCode, release.versionCode);
  assert.equal(manifest.versionName, release.versionName);
  assert.equal(manifest.channel, release.channel);
  assert.ok(manifest.releaseId && !Number.isNaN(Date.parse(manifest.publishedAt)));

  const bytes = readFileSync(apkPath);
  assert.equal(manifest.apkSize, statSync(apkPath).size);
  assert.equal(manifest.apkSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "APK must be a ZIP archive");
  assert.equal(bytes.includes(Buffer.from("assets/public/releases/")), false, "APK must not embed an OTA APK");

  const apkUrl = new URL(manifest.apkUrl);
  assert.equal(apkUrl.protocol, "https:");
  assert.equal(apkUrl.host, new URL(release.otaManifestUrl).host);
  assert.equal(apkUrl.pathname, "/releases/TrustID.apk");

  assert.ok(Array.isArray(manifest.signerSha256) && manifest.signerSha256.length > 0);
  for (const signer of manifest.signerSha256) assert.match(signer, HEX64);
  assert.ok(Number.isInteger(manifest.minSdk) && manifest.minSdk >= 1);

  const text = readFileSync(manifestPath, "utf8").toLowerCase();
  for (const forbidden of ["password", "secret", "private", "keystore", "token", "storepass"]) {
    assert.equal(text.includes(forbidden), false, `manifest must not mention ${forbidden}`);
  }
});

test("Netlify serves the OTA manifest uncached with explicit content types", () => {
  const toml = readFileSync(join(root, "netlify.toml"), "utf8");
  const manifestBlock = toml.split('for = "/releases/trustid-android.json"')[1]?.split("[[")[0] ?? "";
  assert.match(manifestBlock, /application\/json/);
  assert.match(manifestBlock, /no-cache/);
  const apkBlock = toml.split('for = "/releases/TrustID.apk"')[1]?.split("[[")[0] ?? "";
  assert.match(apkBlock, /application\/vnd\.android\.package-archive/);
});
