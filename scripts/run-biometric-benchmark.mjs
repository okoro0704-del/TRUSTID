#!/usr/bin/env node
/**
 * Labeled biometric accuracy harness.
 *
 * Usage:
 *   node scripts/run-biometric-benchmark.mjs --dataset path/to/labeled.json
 *   node scripts/run-biometric-benchmark.mjs --plumbing-only
 *
 * Dataset embeddings MUST come from the TrustID ArcFace production pipeline.
 * --plumbing-only exercises metric math on synthetic vectors and MUST NOT be
 * reported as biometric accuracy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { dataset: null, plumbingOnly: false, out: null, threshold: 0.35 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") out.dataset = argv[++i];
    else if (a === "--plumbing-only") out.plumbingOnly = true;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--threshold") out.threshold = Number(argv[++i]);
  }
  return out;
}

async function loadBenchModules() {
  // Prefer compiled dist; fall back to vitest-friendly dynamic import via tsx if needed.
  const dist = join(root, "packages/sdk/dist/capture/biometric/benchmark/index.js");
  try {
    return await import(pathToFileURL(dist).href);
  } catch {
    // Build SDK first if missing
    const { execSync } = await import("node:child_process");
    execSync("npm run build -w @trustid/sdk", { cwd: root, stdio: "inherit" });
    return await import(pathToFileURL(dist).href);
  }
}

const args = parseArgs(process.argv);
const bench = await loadBenchModules();

let dataset;
if (args.plumbingOnly) {
  dataset = bench.makeSyntheticPlumbingDataset();
} else if (args.dataset) {
  const raw = JSON.parse(readFileSync(resolve(args.dataset), "utf8"));
  dataset = bench.parseLabeledDataset(raw);
  if (
    dataset.modelName !== "insightface_arcface_w600k_mbf_v1" ||
    dataset.modelVersion !== 1
  ) {
    console.warn(
      "WARNING: dataset modelName/version does not match production; do not claim TrustID accuracy.",
    );
  }
} else {
  console.error(
    "Provide --dataset <labeled.json> or --plumbing-only (metric math only, not accuracy).",
  );
  process.exit(2);
}

const verification = bench.computeVerificationReport(dataset, {
  operatingThresholdDistance: args.threshold,
});
const calibration = bench.calibrateThreshold(verification, args.threshold);
const identification = bench.buildGalleriesWhereDataPermits(
  dataset,
  [10_000, 100_000, 1_000_000, 10_000_000],
  args.threshold,
);
const templateQuality = bench.evaluateTemplateQuality(dataset, args.threshold);
const demographics = bench.evaluateDemographicSplits(dataset, args.threshold);

const report = {
  generatedAt: new Date().toISOString(),
  disclaimer: dataset.syntheticPlumbingOnly
    ? "SYNTHETIC_PLUMBING_ONLY — not biometric accuracy"
    : "Labeled dataset evaluation — valid only if embeddings came from production ArcFace pipeline",
  verification: {
    ...verification,
    // Drop raw score arrays from default stdout summary (keep in --out)
    genuineSimilarities: undefined,
    impostorSimilarities: undefined,
    rocPoints: verification.roc.length,
    roc: undefined,
  },
  calibration,
  identification,
  templateQuality,
  demographics,
  failureModes: {
    status: dataset.samples.some((s) => s.failureModes?.length)
      ? "LABELS_PRESENT_RUN_PER_TAG_ANALYSIS_MANUALLY"
      : "NO_FAILURE_MODE_LABELS",
  },
};

const summary = {
  ...report,
  verification: {
    ...report.verification,
    genuineSimilarities: verification.genuineSimilarities,
    impostorSimilarities: verification.impostorSimilarities,
    roc: verification.roc,
  },
};

console.log(JSON.stringify(report, null, 2));
if (args.out) {
  writeFileSync(resolve(args.out), JSON.stringify(summary, null, 2));
  console.error(`Wrote full report to ${args.out}`);
}

if (!args.dataset && !args.plumbingOnly) process.exit(2);
if (
  !dataset.syntheticPlumbingOnly &&
  verification.status === "INSUFFICIENT_DATA"
) {
  process.exitCode = 3;
}
