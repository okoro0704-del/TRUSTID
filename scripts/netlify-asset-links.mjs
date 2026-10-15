#!/usr/bin/env node
/**
 * Netlify: generate /.well-known/assetlinks.json (Digital Asset Links) for THIS deployment only.
 *
 * Android Credential Manager releases a passkey to an app only if the RP domain's statements name
 * that app's package and signing certificate. Each environment states exactly its own app:
 *   production site → com.trustid.device          + TRUSTID_ANDROID_SIGNING_SHA256 (release cert);
 *                      no cert configured → no file (the path answers 404, never the SPA HTML)
 *   staging site    → com.trustid.device.staging  + TRUSTID_ANDROID_SIGNING_SHA256 (staging cert);
 *                      required: the build fails without it
 *   deploy previews → no file
 * Known debug certificates are refused everywhere. TRUSTID_ANDROID_PACKAGE, if set, must equal the
 * environment's package (guards against pointing one environment at the other's app).
 *
 * The environment comes from the same resolution as the /api routing (scripts/netlify-api-routing.mjs).
 * Usage (Netlify build command): node scripts/netlify-asset-links.mjs apps/web/dist
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveApiRouting, RoutingError } from "./netlify-api-routing.mjs";

export const ANDROID_PACKAGES = { production: "com.trustid.device", staging: "com.trustid.device.staging" };
/** Android debug certificate that signed the development-channel TrustID.apk: never trusted. */
export const KNOWN_DEBUG_CERT_SHA256 = new Set(["8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa"]);

function certificates(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      const hex = value.toLowerCase().replace(/:/g, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new RoutingError(`TRUSTID_ANDROID_SIGNING_SHA256 entry is not a SHA-256 fingerprint: ${value}`);
      if (KNOWN_DEBUG_CERT_SHA256.has(hex)) throw new RoutingError("TRUSTID_ANDROID_SIGNING_SHA256 is a debug certificate; it is never trusted for a release");
      return hex;
    });
}

const colonUpper = (hex) => hex.toUpperCase().match(/../g).join(":");

/** The statements for a Netlify build environment, or null when no file must be served. */
export function assetLinksFor(env) {
  const { environment } = resolveApiRouting(env);
  if (environment !== "production" && environment !== "staging") return { environment, statements: null };
  const pkg = ANDROID_PACKAGES[environment];
  const override = env.TRUSTID_ANDROID_PACKAGE?.trim();
  if (override && override !== pkg) {
    throw new RoutingError(`TRUSTID_ANDROID_PACKAGE "${override}" is not the ${environment} app (${pkg})`);
  }
  const certs = certificates(env.TRUSTID_ANDROID_SIGNING_SHA256);
  if (!certs.length) {
    if (environment === "staging") throw new RoutingError("staging requires TRUSTID_ANDROID_SIGNING_SHA256 (the staging signing certificate)");
    return { environment, statements: null };
  }
  return {
    environment,
    statements: [
      {
        relation: ["delegate_permission/common.get_login_creds"],
        target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: certs.map(colonUpper) },
      },
    ],
  };
}

function main() {
  const publishDir = process.argv[2];
  if (!publishDir) {
    console.error("usage: node scripts/netlify-asset-links.mjs <publish dir>");
    process.exit(2);
  }
  let result;
  try {
    result = assetLinksFor(process.env);
  } catch (err) {
    console.error(`netlify-asset-links: ${err.message}`);
    process.exit(1);
  }
  const file = join(publishDir, ".well-known", "assetlinks.json");
  if (!result.statements) {
    rmSync(file, { force: true });
    console.log(`netlify-asset-links: ${result.environment} → no Digital Asset Links (404)`);
    return;
  }
  mkdirSync(join(publishDir, ".well-known"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result.statements, null, 2)}\n`);
  const t = result.statements[0].target;
  console.log(`netlify-asset-links: ${result.environment} → ${t.package_name} (${t.sha256_cert_fingerprints.length} certificate(s))`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
