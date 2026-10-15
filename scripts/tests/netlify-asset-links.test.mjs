import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assetLinksFor } from "../netlify-asset-links.mjs";

// Non-secret test fixtures, not real certificates.
const RELEASE = "ab".repeat(32);
const STAGING_CERT = "5a".repeat(32);
const DEBUG = "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa";
const prodSite = { SITE_NAME: "trustedid", CONTEXT: "production" };
const stagingSite = { SITE_NAME: "trustid-staging", CONTEXT: "production", TRUSTID_DEPLOY_ENV: "staging", TRUSTID_API_PROXY_ORIGIN: "https://trustid-api-staging.up.railway.app" };

const target = (r) => r.statements?.[0]?.target;

test("staging states only the staging app and its staging certificate", () => {
  const r = assetLinksFor({ ...stagingSite, TRUSTID_ANDROID_SIGNING_SHA256: STAGING_CERT });
  assert.equal(r.environment, "staging");
  assert.equal(r.statements.length, 1);
  assert.deepEqual(r.statements[0].relation, ["delegate_permission/common.get_login_creds"]);
  assert.deepEqual(target(r), { namespace: "android_app", package_name: "com.trustid.device.staging", sha256_cert_fingerprints: [STAGING_CERT.toUpperCase().match(/../g).join(":")] });
  assert.doesNotMatch(JSON.stringify(r), /"com\.trustid\.device"/);
  JSON.parse(JSON.stringify(r.statements)); // valid JSON round trip
});

test("staging fails closed without its certificate, and rejects production or debug identities", () => {
  assert.throws(() => assetLinksFor(stagingSite), /staging requires TRUSTID_ANDROID_SIGNING_SHA256/);
  assert.throws(() => assetLinksFor({ ...stagingSite, TRUSTID_ANDROID_SIGNING_SHA256: STAGING_CERT, TRUSTID_ANDROID_PACKAGE: "com.trustid.device" }), /not the staging app/);
  assert.throws(() => assetLinksFor({ ...stagingSite, TRUSTID_ANDROID_SIGNING_SHA256: DEBUG }), /debug certificate/);
  assert.throws(() => assetLinksFor({ ...stagingSite, TRUSTID_ANDROID_SIGNING_SHA256: "not-a-fingerprint" }), /not a SHA-256 fingerprint/);
  // staging routing itself still fails closed without its API
  assert.throws(() => assetLinksFor({ ...stagingSite, TRUSTID_API_PROXY_ORIGIN: "", TRUSTID_ANDROID_SIGNING_SHA256: STAGING_CERT }));
});

test("production states only the production app, never the staging app or a debug certificate", () => {
  const r = assetLinksFor({ ...prodSite, TRUSTID_ANDROID_SIGNING_SHA256: RELEASE.toUpperCase().match(/../g).join(":") });
  assert.equal(target(r).package_name, "com.trustid.device");
  assert.deepEqual(target(r).sha256_cert_fingerprints, [RELEASE.toUpperCase().match(/../g).join(":")]);
  assert.doesNotMatch(JSON.stringify(r), /staging/);
  assert.throws(() => assetLinksFor({ ...prodSite, TRUSTID_ANDROID_SIGNING_SHA256: RELEASE, TRUSTID_ANDROID_PACKAGE: "com.trustid.device.staging" }), /not the production app/);
  assert.throws(() => assetLinksFor({ ...prodSite, TRUSTID_ANDROID_SIGNING_SHA256: DEBUG }), /debug certificate/);
  assert.throws(() => assetLinksFor({ ...prodSite, TRUSTID_ANDROID_SIGNING_SHA256: `${RELEASE},${DEBUG}` }), /debug certificate/);
});

test("production without a release certificate, and deploy previews, serve no statements", () => {
  assert.deepEqual(assetLinksFor(prodSite), { environment: "production", statements: null });
  assert.deepEqual(assetLinksFor({ SITE_NAME: "trustedid", CONTEXT: "deploy-preview", TRUSTID_ANDROID_SIGNING_SHA256: RELEASE }), { environment: "preview", statements: null });
});

test("the CLI writes /.well-known/assetlinks.json, removes a stale one, and fails the build when staging is incomplete", () => {
  const dir = mkdtempSync(join(tmpdir(), "trustid-assetlinks-"));
  const file = join(dir, ".well-known", "assetlinks.json");
  const script = fileURLToPath(new URL("../netlify-asset-links.mjs", import.meta.url));
  const run = (env) => execFileSync(process.execPath, [script, dir], { env: { PATH: process.env.PATH, ...env }, stdio: "pipe", encoding: "utf8" });
  try {
    run({ ...stagingSite, TRUSTID_ANDROID_SIGNING_SHA256: STAGING_CERT });
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written[0].target.package_name, "com.trustid.device.staging");
    assert.throws(() => run(stagingSite));
    // a stale file (e.g. copied from public/) is removed when this deployment has no statements
    mkdirSync(join(dir, ".well-known"), { recursive: true });
    writeFileSync(file, "[]");
    run(prodSite);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Netlify serves the generated file as JSON and answers 404 (not the SPA) when there is none", () => {
  const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /node scripts\/netlify-asset-links\.mjs apps\/web\/dist"/);
  assert.match(toml, /for = "\/\.well-known\/assetlinks\.json"\s+\[headers\.values\]\s+Content-Type = "application\/json"/);
  const rule = toml.indexOf('from = "/.well-known/assetlinks.json"');
  assert.ok(rule > 0 && rule < toml.indexOf('from = "/*"'), "404 rule precedes the SPA fallback");
  assert.match(toml.slice(rule, rule + 120), /status = 404/);
  assert.doesNotMatch(toml.slice(rule, rule + 120), /force = true/);
  assert.equal(existsSync(new URL("../../apps/web/public/.well-known/assetlinks.json", import.meta.url)), false, "no static (debug) statements in the repo");
});
