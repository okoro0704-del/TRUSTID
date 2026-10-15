import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PRODUCTION_API_ORIGIN, redirectsFor, resolveApiRouting, RoutingError } from "../netlify-api-routing.mjs";

const STAGING_API = "https://trustid-api-staging.up.railway.app";
const prodSite = { SITE_NAME: "trustedid", CONTEXT: "production" };

test("production site, production context: production API only", () => {
  assert.deepEqual(resolveApiRouting(prodSite), { environment: "production", target: PRODUCTION_API_ORIGIN });
  assert.deepEqual(resolveApiRouting({ ...prodSite, TRUSTID_API_PROXY_ORIGIN: `${PRODUCTION_API_ORIGIN}/` }).target, PRODUCTION_API_ORIGIN);
  assert.throws(() => resolveApiRouting({ ...prodSite, TRUSTID_API_PROXY_ORIGIN: STAGING_API }), RoutingError);
  assert.throws(() => resolveApiRouting({ ...prodSite, TRUSTID_DEPLOY_ENV: "staging", TRUSTID_API_PROXY_ORIGIN: STAGING_API }), /production site/);
  const redirects = redirectsFor(resolveApiRouting(prodSite));
  assert.match(redirects, /^\/api\/\*  https:\/\/lucid-integrity-production\.up\.railway\.app\/:splat  200!$/m);
  // the alias host still redirects, ahead of /api
  assert.ok(redirects.indexOf("trustid.getlifeos.app/*") < redirects.indexOf("/api/*"));
});

test("staging: its own API, required, and never production", () => {
  const env = { SITE_NAME: "trustid-staging", CONTEXT: "production", TRUSTID_DEPLOY_ENV: "staging" };
  assert.deepEqual(resolveApiRouting({ ...env, TRUSTID_API_PROXY_ORIGIN: STAGING_API }), { environment: "staging", target: STAGING_API });
  assert.throws(() => resolveApiRouting(env), /TRUSTID_API_PROXY_ORIGIN must be an https origin/);
  for (const bad of [PRODUCTION_API_ORIGIN, "https://trustedid.netlify.app", "http://trustid-api-staging.up.railway.app", "https://x.example/api", "not a url"]) {
    assert.throws(() => resolveApiRouting({ ...env, TRUSTID_API_PROXY_ORIGIN: bad }), RoutingError, bad);
  }
  // staging deploy previews follow the staging site, still never production
  assert.equal(resolveApiRouting({ ...env, CONTEXT: "deploy-preview", TRUSTID_API_PROXY_ORIGIN: STAGING_API }).target, STAGING_API);
  const redirects = redirectsFor(resolveApiRouting({ ...env, TRUSTID_API_PROXY_ORIGIN: STAGING_API }));
  assert.doesNotMatch(redirects, /lucid-integrity-production|trustedid\.netlify\.app/);
});

test("deploy previews and branch deploys of the production site: no API unless a non-production preview API is set", () => {
  for (const CONTEXT of ["deploy-preview", "branch-deploy"]) {
    const routing = resolveApiRouting({ SITE_NAME: "trustedid", CONTEXT });
    assert.deepEqual(routing, { environment: "preview", target: null });
    const redirects = redirectsFor(routing);
    assert.match(redirects, /^\/api\/\*  \/404\.html  404!$/m);
    assert.doesNotMatch(redirects, /railway|https:/);
    assert.equal(resolveApiRouting({ SITE_NAME: "trustedid", CONTEXT, TRUSTID_PREVIEW_API_ORIGIN: STAGING_API }).target, STAGING_API);
    assert.throws(() => resolveApiRouting({ SITE_NAME: "trustedid", CONTEXT, TRUSTID_PREVIEW_API_ORIGIN: PRODUCTION_API_ORIGIN }), RoutingError);
  }
});

test("unknown or incomplete environments fail closed (no production fallback)", () => {
  assert.throws(() => resolveApiRouting({}), RoutingError);
  assert.throws(() => resolveApiRouting({ SITE_NAME: "someone-else", CONTEXT: "production" }), RoutingError);
  assert.throws(() => resolveApiRouting({ SITE_NAME: "trustedid", CONTEXT: "dev" }), RoutingError);
  assert.throws(() => resolveApiRouting({ ...prodSite, TRUSTID_DEPLOY_ENV: "prod" }), /must be "staging" or "production"/);
});

test("the CLI writes _redirects, and refuses to build when routing is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "trustid-routing-"));
  try {
    const script = new URL("../netlify-api-routing.mjs", import.meta.url);
    const run = (env) => execFileSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, "$1"), dir], { env: { PATH: process.env.PATH, ...env }, stdio: "pipe" });
    run({ SITE_NAME: "trustid-staging", CONTEXT: "production", TRUSTID_DEPLOY_ENV: "staging", TRUSTID_API_PROXY_ORIGIN: STAGING_API });
    assert.match(readFileSync(join(dir, "_redirects"), "utf8"), /trustid-api-staging\.up\.railway\.app\/:splat/);
    assert.throws(() => run({ SITE_NAME: "trustid-staging", CONTEXT: "production", TRUSTID_DEPLOY_ENV: "staging" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("netlify.toml has no production API target and runs the routing step", () => {
  const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
  assert.doesNotMatch(toml, /to = "https:\/\/lucid-integrity-production/);
  assert.match(toml, /node scripts\/netlify-api-routing\.mjs apps\/web\/dist( |")/);
  assert.match(toml, /from = "\/api\/\*"\s+to = "\/404\.html"\s+status = 404/);
});
