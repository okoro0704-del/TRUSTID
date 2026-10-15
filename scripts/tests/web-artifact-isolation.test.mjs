import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanWebArtifacts } from "../scan-web-artifacts.mjs";
import { resolveWebEnvironment } from "../trustid-web-environment.mjs";

const STAGING_CERT = "5a57fdf74f2aba1d6a7767915da6a823cfdad06d00fef84593a3bd7979898a52"; // public fingerprint
const DEBUG = "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "trustid-dist-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const links = (pkg, cert) =>
  JSON.stringify([{ relation: ["delegate_permission/common.get_login_creds"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: [cert.toUpperCase().match(/../g).join(":")] } }]);
const clean = {
  "index.html": "<!doctype html><script src=/assets/index.js></script>",
  "assets/index.js": 'fetch("/api/health");const p="com.trustid.device";',
  "_redirects": "/api/*  https://trustid-api-staging-staging.up.railway.app/:splat  200!\n",
  ".well-known/assetlinks.json": links("com.trustid.device.staging", STAGING_CERT),
};
const scan = (files, opts = { env: "staging", pkg: "com.trustid.device.staging", signer: STAGING_CERT }) => {
  const dir = fixture(files);
  try {
    return scanWebArtifacts(dir, opts).findings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("web environment: production only for the production site or the device bundle; staging explicit; everything else development", () => {
  assert.equal(resolveWebEnvironment({ SITE_NAME: "trustedid", CONTEXT: "production" }, "production"), "production");
  assert.equal(resolveWebEnvironment({}, "device"), "production");
  assert.equal(resolveWebEnvironment({ SITE_NAME: "trustid-staging", CONTEXT: "production", TRUSTID_DEPLOY_ENV: "staging" }, "production"), "staging");
  assert.equal(resolveWebEnvironment({ SITE_NAME: "trustedid", CONTEXT: "deploy-preview" }, "production"), "development");
  assert.equal(resolveWebEnvironment({ SITE_NAME: "trustedid", CONTEXT: "branch-deploy" }, "production"), "development");
  assert.equal(resolveWebEnvironment({}, "production"), "development");
  assert.equal(resolveWebEnvironment({ VITE_TRUSTID_DEPLOY_ENV: "staging", SITE_NAME: "trustedid", CONTEXT: "production" }, "production"), "staging");
  assert.throws(() => resolveWebEnvironment({ VITE_TRUSTID_DEPLOY_ENV: "prod" }, "production"), /must be one of/);
});

test("a clean staging build passes", () => {
  assert.deepEqual(scan(clean), []);
});

test("F2: production APKs, release manifests and the retired-alias worker are refused outside production", () => {
  const f = scan({ ...clean, "releases/TrustID.apk": "PK", "releases/trustid-android.json": "{}", "sw-retire.js": "self" });
  assert.ok(f.some((x) => /releases\/TrustID\.apk: Android APK/.test(x)));
  assert.ok(f.some((x) => /trustid-android\.json: Android update manifest/.test(x)));
  assert.ok(f.some((x) => /sw-retire\.js: retired-alias service worker/.test(x)));
  assert.ok(scan({ ...clean, "downloads/other.apk": "PK" }).some((x) => /Android APK/.test(x)));
});

test("F1/F3: production endpoints and the production APK link are refused outside production", () => {
  const f = scan({ ...clean, "assets/index.js": 'const e="https://elfcomnode-production.up.railway.app";const d="https://main--trustedid.netlify.app/releases/TrustID.apk";' });
  assert.ok(f.some((x) => /production Railway endpoint \(elfcomnode-production\.up\.railway\.app\)/.test(x)));
  assert.ok(f.some((x) => /production APK download host/.test(x)));
  assert.ok(f.some((x) => /production APK path/.test(x)));
  assert.ok(scan({ ...clean, "_redirects": "/api/*  https://lucid-integrity-production.up.railway.app/:splat  200!" }).length > 0);
  assert.ok(scan({ ...clean, "assets/x.js": 'fetch("https://trustedid.netlify.app/api/health")' }).some((x) => /production TrustID host/.test(x)));
});

test("asset links: wrong package, wrong or debug certificate, or missing file are refused", () => {
  assert.ok(scan({ ...clean, ".well-known/assetlinks.json": links("com.trustid.device", STAGING_CERT) }).some((x) => /expected only com\.trustid\.device\.staging/.test(x)));
  assert.ok(scan({ ...clean, ".well-known/assetlinks.json": links("com.trustid.device.staging", DEBUG) }).some((x) => /debug certificate/.test(x)));
  assert.ok(scan({ ...clean, ".well-known/assetlinks.json": "{not json" }).some((x) => /not valid JSON/.test(x)));
  const { [".well-known/assetlinks.json"]: _omit, ...noLinks } = clean;
  assert.ok(scan(noLinks).some((x) => /assetlinks\.json: missing/.test(x)));
});

test("private keys and credential-bearing URLs are refused in every environment, production included", () => {
  for (const env of ["production", "staging", "development"]) {
    const f = scan({ "a.js": "-----BEGIN PRIVATE KEY-----\nx", "b.json": '{"u":"postgres://u:p@db:5432/x"}' }, { env });
    assert.ok(f.some((x) => /private key/.test(x)), env);
    assert.ok(f.some((x) => /credential-bearing database URL/.test(x)), env);
  }
  // production may legitimately carry its own release artifacts and hosts
  assert.deepEqual(scan({ "releases/TrustID.apk": "PK", "a.js": 'u="https://elfcomnode-production.up.railway.app"' }, { env: "production" }), []);
});
