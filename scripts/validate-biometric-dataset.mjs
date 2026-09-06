#!/usr/bin/env node
/**
 * Validate a biometric evaluation labeled.json (DATASET_SPEC.md).
 *
 * Usage:
 *   node scripts/validate-biometric-dataset.mjs --dataset labeled.json
 *   node scripts/validate-biometric-dataset.mjs --dataset artifacts/biometric-evaluation/exports/labeled.json --images-root artifacts/biometric-evaluation
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { dataset: null, imagesRoot: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dataset") out.dataset = argv[++i];
    else if (argv[i] === "--images-root") out.imagesRoot = argv[++i];
  }
  return out;
}

async function loadValidate() {
  const dist = join(
    root,
    "packages/sdk/dist/capture/biometric/evaluation/validate.js",
  );
  try {
    return await import(pathToFileURL(dist).href);
  } catch {
    const { execSync } = await import("node:child_process");
    execSync("npm run build -w @trustid/shared && npm run build -w @trustid/sdk", {
      cwd: root,
      stdio: "inherit",
    });
    return await import(pathToFileURL(dist).href);
  }
}

const args = parseArgs(process.argv);
if (!args.dataset) {
  console.error("Usage: node scripts/validate-biometric-dataset.mjs --dataset labeled.json");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(resolve(args.dataset), "utf8"));
const { validateLabeledDatasetJson } = await loadValidate();
const imagesRoot = args.imagesRoot ? resolve(args.imagesRoot) : null;

const result = validateLabeledDatasetJson(raw, {
  requireImagePath: false,
  checkFileExists: imagesRoot
    ? (rel) => existsSync(join(imagesRoot, rel))
    : undefined,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.DATASET_VALID ? 0 : 1);
