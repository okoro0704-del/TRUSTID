#!/usr/bin/env node
/**
 * Export labeled.json from the evaluation filesystem store (offline).
 *
 * Usage:
 *   TRUSTID_EVAL_DATA_ROOT=artifacts/biometric-evaluation \
 *     node scripts/export-biometric-eval-dataset.mjs
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dataRoot = resolve(
  process.env.TRUSTID_EVAL_DATA_ROOT?.trim() ||
    join(root, "artifacts/biometric-evaluation"),
);

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function listCapturesAndConsent() {
  const subjectsDir = join(dataRoot, "subjects");
  if (!existsSync(subjectsDir)) return { captures: [], consentBySubject: new Map() };
  const captures = [];
  const consentBySubject = new Map();
  for (const sid of readdirSync(subjectsDir)) {
    const metaPath = join(subjectsDir, sid, "meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = readJson(metaPath);
    if (meta?.status === "deleted") continue;
    if (!meta?.consent?.consent_given) continue;
    consentBySubject.set(sid, {
      consent_given: true,
      consent_timestamp: meta.consent.consent_timestamp,
      dataset_version: meta.consent.dataset_version,
    });
    const sessionsDir = join(subjectsDir, sid, "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const sess of readdirSync(sessionsDir)) {
      const capDir = join(sessionsDir, sess, "captures");
      if (!existsSync(capDir)) continue;
      for (const f of readdirSync(capDir)) {
        if (!f.endsWith(".json")) continue;
        captures.push(readJson(join(capDir, f)));
      }
    }
  }
  return { captures, consentBySubject };
}

async function loadExport() {
  const dist = join(
    root,
    "packages/sdk/dist/capture/biometric/evaluation/export.js",
  );
  const validateDist = join(
    root,
    "packages/sdk/dist/capture/biometric/evaluation/validate.js",
  );
  try {
    return {
      exportMod: await import(pathToFileURL(dist).href),
      validateMod: await import(pathToFileURL(validateDist).href),
    };
  } catch {
    const { execSync } = await import("node:child_process");
    execSync("npm run build -w @trustid/shared && npm run build -w @trustid/sdk", {
      cwd: root,
      stdio: "inherit",
    });
    return {
      exportMod: await import(pathToFileURL(dist).href),
      validateMod: await import(pathToFileURL(validateDist).href),
    };
  }
}

const { captures, consentBySubject } = listCapturesAndConsent();
const { exportMod, validateMod } = await loadExport();
const labeled = exportMod.buildLabeledExport({ captures, consentBySubject });
const validation = validateMod.validateLabeledDatasetJson(labeled);
const outDir = join(dataRoot, "exports");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "labeled.json");
writeFileSync(outPath, JSON.stringify(labeled, null, 2));
console.log(
  JSON.stringify(
    {
      outPath,
      validation,
      BIOMETRIC_EVIDENCE_STATUS:
        validation.stats.subjects > 0
          ? "DATASET_EXPORTED_NOT_YET_BENCHMARKED"
          : "BLOCKED_BY_DATASET",
    },
    null,
    2,
  ),
);
process.exit(validation.DATASET_VALID || validation.stats.samples === 0 ? 0 : 1);
