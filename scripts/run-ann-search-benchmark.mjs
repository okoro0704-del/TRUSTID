#!/usr/bin/env node
/**
 * ANN / search-engine scaling benchmark — SYNTHETIC VECTORS ONLY.
 *
 * This measures infrastructure latency of brute-force cosine search in Node.
 * It does NOT measure face-recognition accuracy.
 * It does NOT substitute for pgvector/HNSW production benchmarks
 * (those require DATABASE_URL + a live Postgres with pgvector).
 *
 * Usage:
 *   node scripts/run-ann-search-benchmark.mjs
 *   node scripts/run-ann-search-benchmark.mjs --sizes 10000,100000
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIMS = 512;
const DEFAULT_SIZES = [10_000, 100_000, 1_000_000];

function parseArgs(argv) {
  const out = { sizes: DEFAULT_SIZES, out: null, probes: 32 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sizes") {
      out.sizes = argv[++i].split(",").map((x) => Number(x.trim()));
    } else if (a === "--out") out.out = argv[++i];
    else if (a === "--probes") out.probes = Number(argv[++i]);
  }
  return out;
}

function fillUnitRow(out, seed) {
  // Deterministic pseudo-random unit vector into Float32Array view
  let s = seed >>> 0;
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = (s / 0x100000000) * 2 - 1;
    out[i] = v;
    sum += v * v;
  }
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
}

function cosineDistance(a, bOffset, gallery, dims) {
  let dot = 0;
  for (let i = 0; i < dims; i++) dot += a[i] * gallery[bOffset + i];
  return 1 - dot;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

const args = parseArgs(process.argv);
const results = [];

console.error(
  "ANN SEARCH PERFORMANCE ONLY — not biometric accuracy. Synthetic unit vectors.",
);

for (const n of args.sizes) {
  const bytes = n * DIMS * 4;
  const gb = bytes / (1024 ** 3);
  if (gb > 3.5) {
    results.push({
      gallerySize: n,
      status: "SKIPPED_MEMORY",
      reason: `Would allocate ~${gb.toFixed(2)} GiB Float32 gallery (>3.5 GiB safety cap)`,
      kind: "ANN_SEARCH_PERFORMANCE",
      biometricAccuracy: "NOT_APPLICABLE",
    });
    console.error(`SKIP ${n}: memory cap`);
    continue;
  }

  console.error(`Building gallery n=${n} (~${(bytes / 1024 / 1024).toFixed(1)} MiB)...`);
  const tBuild0 = performance.now();
  const gallery = new Float32Array(n * DIMS);
  const tmp = new Float32Array(DIMS);
  for (let i = 0; i < n; i++) {
    fillUnitRow(tmp, i + 1);
    gallery.set(tmp, i * DIMS);
  }
  const buildMs = performance.now() - tBuild0;

  const probe = new Float32Array(DIMS);
  fillUnitRow(probe, 99_001);
  // Plant a near-duplicate of probe at index 0 for recall@1 check on brute force
  gallery.set(probe, 0);

  const latencies = [];
  let recall1Hits = 0;
  let recall10Hits = 0;

  for (let p = 0; p < args.probes; p++) {
    fillUnitRow(probe, 100_000 + p);
    // For recall: plant exact match at known index
    const plantIdx = (p * 9973) % n;
    gallery.set(probe, plantIdx * DIMS);

    const t0 = performance.now();
    let best = Infinity;
    let bestIdx = -1;
    const top10 = [];
    for (let i = 0; i < n; i++) {
      const d = cosineDistance(probe, i * DIMS, gallery, DIMS);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
      if (top10.length < 10) {
        top10.push({ i, d });
        top10.sort((a, b) => a.d - b.d);
      } else if (d < top10[9].d) {
        top10[9] = { i, d };
        top10.sort((a, b) => a.d - b.d);
      }
    }
    latencies.push(performance.now() - t0);
    if (bestIdx === plantIdx) recall1Hits++;
    if (top10.some((x) => x.i === plantIdx)) recall10Hits++;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const totalMs = latencies.reduce((s, x) => s + x, 0);
  const row = {
    kind: "ANN_SEARCH_PERFORMANCE",
    engine: "node_bruteforce_float32",
    note: "NOT pgvector/HNSW. Exact linear scan for baseline latency only.",
    biometricAccuracy: "NOT_APPLICABLE",
    gallerySize: n,
    dims: DIMS,
    indexBuildMs: buildMs,
    indexSizeBytes: bytes,
    ramBytesApprox: bytes,
    queryLatencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      mean: totalMs / latencies.length,
    },
    qps: (latencies.length * 1000) / totalMs,
    recallAt1: recall1Hits / args.probes,
    recallAt10: recall10Hits / args.probes,
    concurrency: 1,
    probes: args.probes,
    status: "MEASURED",
  };
  results.push(row);
  console.error(
    `n=${n} p50=${row.queryLatencyMs.p50.toFixed(2)}ms qps=${row.qps.toFixed(2)} recall@1=${row.recallAt1}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  category: "ANN_SEARCH_PERFORMANCE",
  notBiometricAccuracy: true,
  pgvectorHnsw: {
    status: "NOT_RUN",
    reason: "No DATABASE_URL in this environment",
    configuredParams: {
      m: 16,
      ef_construction: 64,
      ef_search: 40,
      limit: 1,
      distanceMetric: "cosine (<=>)",
      thresholdDistance: 0.35,
    },
    requiredFor: [
      "index build time on Postgres",
      "index size on disk",
      "RAM/CPU under load",
      "HNSW recall@1/@10 vs exact",
      "multi-client QPS",
      "scales 10M / 100M / 1B",
    ],
  },
  results,
};

console.log(JSON.stringify(report, null, 2));
if (args.out) {
  writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
}
