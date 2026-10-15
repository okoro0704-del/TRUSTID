import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { redirectsFor, resolveApiRouting } from "../netlify-api-routing.mjs";

/** [[redirects]] blocks of netlify.toml, in order (from, to, status, force). */
function tomlRedirects() {
  const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  return toml
    .split("[[redirects]]")
    .slice(1)
    .map((block) => {
      const field = (name) => block.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "");
      return { from: field("from"), to: field("to"), status: Number(field("status") ?? 301), force: field("force") === "true" };
    });
}

/** The _redirects lines generated for a build, as rule objects (applied before netlify.toml). */
function generatedRedirects(env) {
  return redirectsFor(resolveApiRouting(env))
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [from, to, code] = l.split(/\s+/);
      return { from, to, status: Number(code.replace("!", "")), force: code.endsWith("!") };
    });
}

const matches = (pattern, path) => {
  if (pattern.includes("://")) return false; // host-scoped rules never match the site's own host here
  if (pattern.endsWith("/*")) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1));
  return path === pattern;
};

/**
 * Netlify's routing for a path: rules in order; a non-forced rule is skipped when a file exists at the
 * path ("shadowing"); without a matching rule an existing file is served, otherwise a 404.
 */
function route(path, files, rules) {
  for (const rule of rules) {
    if (!matches(rule.from, path)) continue;
    if (!rule.force && files.has(path)) return { status: 200, body: `file:${path}` };
    return { status: rule.status, body: rule.status === 404 ? "404" : `rewrite:${rule.to}` };
  }
  return files.has(path) ? { status: 200, body: `file:${path}` } : { status: 404, body: "404" };
}

const stagingEnv = { SITE_NAME: "trustid-staging", CONTEXT: "production", TRUSTID_DEPLOY_ENV: "staging", TRUSTID_API_PROXY_ORIGIN: "https://trustid-api-staging-staging.up.railway.app" };
const productionEnv = { SITE_NAME: "trustedid", CONTEXT: "production" };
const previewEnv = { SITE_NAME: "trustedid", CONTEXT: "deploy-preview" };
const common = ["/index.html", "/assets/index-abc.js", "/sw.js"];

test("the /releases/* 404 rule exists, is not forced, and precedes the SPA fallback", () => {
  const rules = tomlRedirects();
  const i = rules.findIndex((r) => r.from === "/releases/*");
  const spa = rules.findIndex((r) => r.from === "/*");
  assert.ok(i >= 0, "rule present");
  assert.equal(rules[i].status, 404);
  assert.equal(rules[i].force, false, "not forced: real release files are still served");
  assert.ok(i < spa, "before the SPA fallback");
  assert.equal(spa, rules.length - 1, "SPA fallback stays last");
  assert.deepEqual({ to: rules[spa].to, status: rules[spa].status }, { to: "/index.html", status: 200 });
});

test("staging and preview builds (no release files): missing APK and update manifest are 404, never the SPA page", () => {
  for (const env of [stagingEnv, previewEnv]) {
    const rules = [...generatedRedirects(env), ...tomlRedirects()];
    const files = new Set(common);
    for (const path of ["/releases/TrustID.apk", "/releases/trustid-android.json", "/releases/anything-else.apk", "/releases/"]) {
      assert.deepEqual(route(path, files, rules), { status: 404, body: "404" }, `${env.SITE_NAME}/${env.CONTEXT} ${path}`);
    }
  }
});

test("SPA navigation still works, and a missing asset chunk is still a 404", () => {
  const rules = [...generatedRedirects(stagingEnv), ...tomlRedirects()];
  const files = new Set(common);
  for (const path of ["/", "/identity", "/account/security", "/oauth/consent"]) {
    assert.deepEqual(route(path, files, rules), { status: 200, body: "rewrite:/index.html" }, path);
  }
  assert.equal(route("/assets/missing.js", files, rules).status, 404);
  assert.equal(route("/api/health", files, rules).body, "rewrite:https://trustid-api-staging-staging.up.railway.app/:splat");
});

test("production: published release files are served unchanged", () => {
  const rules = [...generatedRedirects(productionEnv), ...tomlRedirects()];
  const files = new Set([...common, "/releases/TrustID.apk", "/releases/trustid-android.json"]);
  assert.deepEqual(route("/releases/TrustID.apk", files, rules), { status: 200, body: "file:/releases/TrustID.apk" });
  assert.deepEqual(route("/releases/trustid-android.json", files, rules), { status: 200, body: "file:/releases/trustid-android.json" });
  assert.equal(route("/releases/missing.apk", files, rules).status, 404);
  // the release headers that production downloads rely on are unchanged
  const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /for = "\/releases\/TrustID\.apk"[\s\S]*?Content-Type = "application\/vnd\.android\.package-archive"/);
  assert.match(toml, /for = "\/releases\/trustid-android\.json"[\s\S]*?Content-Type = "application\/json; charset=utf-8"/);
});
