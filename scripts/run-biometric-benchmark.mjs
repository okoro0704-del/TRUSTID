#!/usr/bin/env node
/**
 * Labeled biometric accuracy harness + evidence exporter.
 *
 * Usage:
 *   node scripts/run-biometric-benchmark.mjs --dataset path/to/labeled.json --out-dir artifacts/biometric-evidence
 *   node scripts/run-biometric-benchmark.mjs --plumbing-only   # metric math only — NOT accuracy
 *   node scripts/run-biometric-benchmark.mjs --evidence-blocked  # write BLOCKED_BY_DATASET package
 *
 * Embeddings MUST come from the TrustID ArcFace production pipeline.
 * Cosine distance = 1 - cosine similarity (lower distance = more similar).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {
    dataset: null,
    plumbingOnly: false,
    evidenceBlocked: false,
    out: null,
    outDir: null,
    threshold: 0.35,
    developmentSplit: null,
    testSplit: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") out.dataset = argv[++i];
    else if (a === "--plumbing-only") out.plumbingOnly = true;
    else if (a === "--evidence-blocked") out.evidenceBlocked = true;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--threshold") out.threshold = Number(argv[++i]);
    else if (a === "--development-split") out.developmentSplit = argv[++i];
    else if (a === "--test-split") out.testSplit = argv[++i];
  }
  return out;
}

async function loadBenchModules() {
  const dist = join(root, "packages/sdk/dist/capture/biometric/benchmark/index.js");
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

function writeCsv(path, headers, rows) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = row[h];
          if (v == null) return "";
          const s = String(v);
          return s.includes(",") || s.includes('"')
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(","),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

function writeBlockedEvidence(outDir) {
  mkdirSync(outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    commitHint: "7f8d197+",
    BIOMETRIC_EVIDENCE_STATUS: "BLOCKED_BY_DATASET",
    PIPELINE_STATUS: "PASS",
    MODEL_STATUS: "PASS",
    BIOMETRIC_ACCURACY_STATUS: "UNMEASURED",
    THRESHOLD_STATUS: "UNCALIBRATED",
    PAD_STATUS: "INCOMPLETE",
    SEARCH_STATUS: "PARTIAL",
    SECURITY_STATUS: "PARTIAL",
    "10B_READINESS_STATUS": "BLOCKED",
    dataset: null,
    subjects: 0,
    genuineTrials: null,
    impostorTrials: null,
    eer: null,
    threshold_0_35: {
      far: null,
      frr: null,
      tar: null,
      status: "NOT_MEASURED",
    },
    calibratedThreshold: null,
    identification: {
      rank1: null,
      rank5: null,
      rank10: null,
      status: "NOT_MEASURED",
    },
    annCandidateRecall: { status: "NOT_MEASURED" },
    searchLatency: { status: "NOT_MEASURED" },
    pgvector: {
      status: "ENVIRONMENT_BLOCKED",
      reason: "DATABASE_URL unavailable in evidence environment",
    },
    multiFrameEnrollment: { status: "NOT_MEASURED" },
    pad: { status: "INCOMPLETE" },
    security: {
      fullGalleryFallback: "REMOVED_FAIL_CLOSED",
      regressionTest: "PASS (vector-matcher-fail-closed.test.ts)",
    },
    MEASURED_FACTS: [
      "ArcFace pipeline I/O measured previously (input.1 ? 512-D)",
      "Full-gallery Node fallback removed; ANN failure ? BIOMETRIC_SERVICE_UNAVAILABLE",
      "Fail-closed regression tests PASS",
    ],
    UNMEASURED_ITEMS: [
      "FAR/FRR/EER/TAR on labeled faces",
      "Operating points at FAR 1e-2…1e-6",
      "1:N Rank-N / FPIR / FNIR",
      "ANN candidate recall vs exact",
      "Live pgvector HNSW scale",
      "Multi-frame vs single-frame accuracy delta",
      "PAD anti-spoof metrics",
    ],
    DATASET_LIMITATIONS:
      "No labeled face dataset with subject_id + images/embeddings from the production pipeline is present in the repository or evidence environment.",
    SECURITY_LIMITATIONS: [
      "THRESHOLD_STATUS=UNCALIBRATED (0.35 is a legacy placeholder)",
      "PAD_STATUS=INCOMPLETE (blink ? presentation-attack detection)",
    ],
    REMAINING_BLOCKERS: [
      "Provide labeled production-pipeline dataset (see DATASET_SPEC.md)",
      "Calibrate threshold from measured FAR/FRR",
      "Run live pgvector HNSW with DATABASE_URL",
      "Validated PAD evaluation",
    ],
    sufficientFor10BArchitectureDesign: false,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(outDir, "genuine_scores.csv"),
    "similarity,distance,status\n# BLOCKED_BY_DATASET — no genuine scores\n",
  );
  writeFileSync(
    join(outDir, "impostor_scores.csv"),
    "similarity,distance,status\n# BLOCKED_BY_DATASET — no impostor scores\n",
  );
  writeFileSync(
    join(outDir, "roc.csv"),
    "threshold_similarity,threshold_distance,far,frr,tar,trr,tp,tn,fp,fn\n# BLOCKED_BY_DATASET\n",
  );
  writeFileSync(
    join(outDir, "thresholds.csv"),
    "target_far,estimability,actual_far,threshold_distance,tar,frr\n# BLOCKED_BY_DATASET\n",
  );
  writeFileSync(
    join(outDir, "identification_results.csv"),
    "gallery_size,rank1,rank5,rank10,fpir,fnir,status\n# BLOCKED_BY_DATASET\n",
  );
  writeFileSync(
    join(outDir, "ann_results.csv"),
    "gallery_size,k,recall_at_k,status\n# BLOCKED_BY_DATASET / ENVIRONMENT_BLOCKED for live ANN\n",
  );
  writeFileSync(
    join(outDir, "latency_results.csv"),
    "stage,p50_ms,p95_ms,p99_ms,status\n# BLOCKED_BY_DATASET\n",
  );
  return report;
}

const args = parseArgs(process.argv);
const defaultOutDir = resolve(root, "artifacts/biometric-evidence");
const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir;

if (args.evidenceBlocked || (!args.dataset && !args.plumbingOnly)) {
  // Default when no dataset: emit blocked evidence package (honest status).
  if (!args.dataset && !args.plumbingOnly) {
    const report = writeBlockedEvidence(outDir);
    console.log(JSON.stringify(report, null, 2));
    console.error(`BIOMETRIC_EVIDENCE_STATUS=BLOCKED_BY_DATASET ? ${outDir}`);
    process.exit(0);
  }
}

const bench = await loadBenchModules();

let dataset;
if (args.plumbingOnly) {
  dataset = bench.makeSyntheticPlumbingDataset();
} else {
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
}

const verification = bench.computeVerificationReport(dataset, {
  operatingThresholdDistance: args.threshold,
});
const calibration = bench.calibrateThreshold(verification, args.threshold);

let holdout = null;
if (args.developmentSplit && args.testSplit && !dataset.syntheticPlumbingOnly) {
  const dev = bench.computeVerificationReport(dataset, {
    operatingThresholdDistance: args.threshold,
    split: args.developmentSplit,
  });
  const proposedDist =
    calibration.proposedThresholdCosineDistance ?? args.threshold;
  const test = bench.computeVerificationReport(dataset, {
    operatingThresholdDistance: proposedDist,
    split: args.testSplit,
  });
  holdout = {
    methodology: "Choose threshold on development split; evaluate on held-out test split",
    developmentSplit: args.developmentSplit,
    testSplit: args.testSplit,
    development: {
      status: dev.status,
      eer: dev.eer,
      eerThresholdDistance: dev.eerThresholdDistance,
      genuineTrials: dev.genuineCount,
      impostorTrials: dev.impostorCount,
    },
    test: {
      status: test.status,
      far: test.farAtThreshold,
      frr: test.frrAtThreshold,
      tar: test.tarAtThreshold,
      eer: test.eer,
      genuineTrials: test.genuineCount,
      impostorTrials: test.impostorCount,
    },
  };
}

const identification = bench.buildGalleriesWhereDataPermits(
  dataset,
  [10_000, 100_000, 1_000_000, 10_000_000],
  args.threshold,
);
const templateQuality = bench.evaluateTemplateQuality(dataset, args.threshold);
const demographics = bench.evaluateDemographicSplits(dataset, args.threshold);

mkdirSync(outDir, { recursive: true });

const full = {
  generatedAt: new Date().toISOString(),
  BIOMETRIC_EVIDENCE_STATUS: dataset.syntheticPlumbingOnly
    ? "SYNTHETIC_PLUMBING_ONLY"
    : verification.status === "MEASURED"
      ? "MEASURED"
      : "INSUFFICIENT_DATA",
  disclaimer: dataset.syntheticPlumbingOnly
    ? "SYNTHETIC_PLUMBING_ONLY — not biometric accuracy"
    : "Labeled dataset evaluation — valid only if embeddings came from production ArcFace pipeline",
  pipelineRecord: {
    model_name: "insightface_arcface_w600k_mbf_v1",
    model_version: 1,
    detector: "mediapipe_face_landmarker_v1",
    alignment_version: "arcface_five_point_v1",
    preprocessing_version: "arcface_112_rgb_v1",
    embedding_dimension: 512,
    normalization: "L2",
    distance_metric: "cosine_distance (= 1 - cosine_similarity)",
    pipeline_version: "trustid_face_pipeline_v1",
    note: "Lower cosine distance = greater similarity",
  },
  verification,
  calibration,
  holdout,
  identification,
  templateQuality,
  demographics,
  conditionAnalysis: {
    status: dataset.samples.some((s) => s.failureModes?.length)
      ? "LABELS_PRESENT"
      : "NOT_AVAILABLE",
  },
};

writeFileSync(join(outDir, "report.json"), JSON.stringify(full, null, 2));
if (args.out) writeFileSync(resolve(args.out), JSON.stringify(full, null, 2));

writeCsv(
  join(outDir, "genuine_scores.csv"),
  ["similarity", "distance"],
  verification.genuineSimilarities.map((s, i) => ({
    similarity: s,
    distance: verification.genuineDistances[i],
  })),
);
writeCsv(
  join(outDir, "impostor_scores.csv"),
  ["similarity", "distance"],
  verification.impostorSimilarities.map((s, i) => ({
    similarity: s,
    distance: verification.impostorDistances[i],
  })),
);
writeCsv(
  join(outDir, "roc.csv"),
  [
    "threshold_similarity",
    "threshold_distance",
    "far",
    "frr",
    "tar",
    "trr",
    "tp",
    "tn",
    "fp",
    "fn",
  ],
  verification.roc.map((p) => ({
    threshold_similarity: p.thresholdSimilarity,
    threshold_distance: p.thresholdDistance,
    far: p.far,
    frr: p.frr,
    tar: p.tar,
    trr: p.trr,
    tp: p.tp,
    tn: p.tn,
    fp: p.fp,
    fn: p.fn,
  })),
);
writeCsv(
  join(outDir, "thresholds.csv"),
  [
    "target_far",
    "estimability",
    "actual_far",
    "threshold_distance",
    "tar",
    "frr",
    "genuine_trials",
    "impostor_trials",
  ],
  verification.operatingPoints.map((op) => ({
    target_far: op.targetFar,
    estimability: op.estimability,
    actual_far: op.actualFar,
    threshold_distance: op.thresholdDistance,
    tar: op.tar,
    frr: op.frr,
    genuine_trials: op.genuineTrials,
    impostor_trials: op.impostorTrials,
  })),
);
writeCsv(
  join(outDir, "identification_results.csv"),
  ["gallery_size", "rank1", "rank5", "rank10", "fpir", "fnir", "status"],
  identification.map((r) => ({
    gallery_size: r.gallerySize,
    rank1: r.rank1,
    rank5: r.rank5,
    rank10: r.rank10,
    fpir: r.fpir,
    fnir: r.fnir,
    status: r.status,
  })),
);

const summary = {
  ...full,
  verification: {
    ...verification,
    genuineSimilarities: undefined,
    impostorSimilarities: undefined,
    genuineDistances: undefined,
    impostorDistances: undefined,
    rocPoints: verification.roc.length,
    roc: undefined,
  },
};

console.log(JSON.stringify(summary, null, 2));
console.error(`Wrote evidence to ${outDir}`);

if (dataset.syntheticPlumbingOnly) process.exitCode = 0;
else if (verification.status === "INSUFFICIENT_DATA") process.exitCode = 3;
