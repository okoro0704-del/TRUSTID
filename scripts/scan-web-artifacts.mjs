#!/usr/bin/env node
/**
 * Scan a built TrustID web output directory (apps/web/dist) for cross-environment leaks.
 *
 * usage: node scripts/scan-web-artifacts.mjs <dist> --env staging|development|production
 *          [--package <android package>] [--signer <sha256 hex>]
 *
 * Non-production builds must not contain:
 *   - production Android release artifacts (any *.apk, releases/, trustid-android.json),
 *   - production endpoints: *-production.up.railway.app (ElfCom, API, ...), the production APK URL,
 *     the production TrustID host trustedid.netlify.app,
 *   - the retired-alias service worker (sw-retire.js).
 * Every build must not contain private keys or credential-bearing URLs. When assetlinks.json exists
 * it must state exactly --package with exactly --signer (and never the known debug certificate).
 * Exit 1 with one line per finding; exit 0 prints a summary.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const DEBUG_CERT = "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa";
const TEXT = /\.(js|mjs|cjs|html|json|css|webmanifest|txt|map|svg)$|^_redirects$|^_headers$/;

const NON_PRODUCTION_PATTERNS = [
  [/[a-z0-9-]+-production\.up\.railway\.app/gi, "production Railway endpoint"],
  [/main--trustedid\.netlify\.app/gi, "production APK download host"],
  [/trustedid\.netlify\.app/gi, "production TrustID host"],
  [/\/releases\/TrustID\.apk/g, "production APK path"],
];
const ALWAYS_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/postgres(?:ql)?:\/\/[^\s"'`:/@]+:[^\s"'`@]+@/gi, "credential-bearing database URL"],
  [/https?:\/\/[^\s"'`:/@]+:[^\s"'`@/]+@/gi, "credential-bearing URL"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function scanWebArtifacts(dist, { env, pkg, signer }) {
  if (!["production", "staging", "development"].includes(env)) throw new Error(`unknown --env ${env}`);
  const findings = [];
  const files = walk(dist);
  const rel = (p) => relative(dist, p).replace(/\\/g, "/");
  for (const file of files) {
    const name = rel(file);
    const base = name.split("/").pop();
    if (env !== "production") {
      if (/\.apk$/i.test(base)) findings.push(`${name}: Android APK in a ${env} build`);
      if (name.startsWith("releases/")) findings.push(`${name}: release artifact in a ${env} build`);
      if (base === "trustid-android.json") findings.push(`${name}: Android update manifest in a ${env} build`);
      if (base === "sw-retire.js") findings.push(`${name}: retired-alias service worker in a ${env} build`);
    }
    if (!TEXT.test(base)) continue;
    const text = readFileSync(file, "utf8");
    const patterns = env === "production" ? ALWAYS_PATTERNS : [...NON_PRODUCTION_PATTERNS, ...ALWAYS_PATTERNS];
    for (const [re, label] of patterns) {
      const hits = [...new Set(text.match(re) ?? [])];
      for (const hit of hits) findings.push(`${name}: ${label} (${hit.slice(0, 80)})`);
    }
  }
  const linksPath = join(dist, ".well-known", "assetlinks.json");
  if (existsSync(linksPath)) {
    let statements;
    try {
      statements = JSON.parse(readFileSync(linksPath, "utf8"));
    } catch {
      findings.push(".well-known/assetlinks.json: not valid JSON");
    }
    if (statements) {
      const targets = statements.map((s) => s.target ?? {});
      const packages = [...new Set(targets.map((t) => t.package_name))];
      const certs = [...new Set(targets.flatMap((t) => t.sha256_cert_fingerprints ?? []).map((c) => c.toLowerCase().replace(/:/g, "")))];
      if (pkg && (packages.length !== 1 || packages[0] !== pkg)) findings.push(`.well-known/assetlinks.json: packages ${packages.join(",")} (expected only ${pkg})`);
      if (signer && (certs.length !== 1 || certs[0] !== signer.toLowerCase().replace(/:/g, ""))) findings.push(`.well-known/assetlinks.json: certificates ${certs.join(",")} (expected only ${signer})`);
      if (certs.includes(DEBUG_CERT)) findings.push(".well-known/assetlinks.json: debug certificate");
    }
  } else if (pkg || signer) {
    findings.push(".well-known/assetlinks.json: missing");
  }
  return { files: files.length, findings };
}

function main() {
  const dist = process.argv[2];
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  if (!dist || !arg("env")) {
    console.error("usage: scan-web-artifacts.mjs <dist> --env staging|development|production [--package p] [--signer sha256]");
    process.exit(2);
  }
  const { files, findings } = scanWebArtifacts(dist, { env: arg("env"), pkg: arg("package"), signer: arg("signer") });
  if (findings.length) {
    for (const f of findings) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`scan-web-artifacts: ${files} files, ${arg("env")} build clean`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
