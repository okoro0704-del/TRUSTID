#!/usr/bin/env node
/**
 * Live pgvector / HNSW benchmark — requires DATABASE_URL to Postgres+pgvector.
 *
 * SYNTHETIC VECTORS ONLY for search infrastructure. Not biometric accuracy.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/run-pgvector-hnsw-benchmark.mjs
 *   DATABASE_URL=... node scripts/run-pgvector-hnsw-benchmark.mjs --sizes 10000 --top-k 10,50,100
 */
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const require = createRequire(join(root, "apps/api/package.json"));

const DIMS = 512;

function parseArgs(argv) {
  const out = {
    sizes: [10_000],
    topK: [10, 50, 100],
    m: 16,
    efConstruction: 64,
    efSearch: 64,
    probes: 16,
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sizes") out.sizes = argv[++i].split(",").map(Number);
    else if (a === "--top-k") out.topK = argv[++i].split(",").map(Number);
    else if (a === "--m") out.m = Number(argv[++i]);
    else if (a === "--ef-construction") out.efConstruction = Number(argv[++i]);
    else if (a === "--ef-search") out.efSearch = Number(argv[++i]);
    else if (a === "--probes") out.probes = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

function unitVec(seed) {
  const v = new Float64Array(DIMS);
  let s = seed >>> 0;
  let sum = 0;
  for (let i = 0; i < DIMS; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = (s / 0x100000000) * 2 - 1;
    v[i] = x;
    sum += x * x;
  }
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}

function toLiteral(v) {
  return `[${Array.from(v)
    .map((x) => Number(x).toFixed(8))
    .join(",")}]`;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    console.log(
      JSON.stringify(
        {
          status: "NOT_RUN",
          reason: "DATABASE_URL must point to Postgres with pgvector",
          kind: "ANN_SEARCH_PERFORMANCE",
          biometricAccuracy: "NOT_APPLICABLE",
          howToRun:
            "DATABASE_URL=postgres://... node scripts/run-pgvector-hnsw-benchmark.mjs --sizes 10000,100000 --top-k 10,50,100",
        },
        null,
        2,
      ),
    );
    return;
  }

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  const report = {
    generatedAt: new Date().toISOString(),
    kind: "ANN_SEARCH_PERFORMANCE",
    biometricAccuracy: "NOT_APPLICABLE",
    note: "Synthetic unit vectors — not face recognition accuracy",
    params: {
      m: args.m,
      efConstruction: args.efConstruction,
      efSearch: args.efSearch,
      dims: DIMS,
    },
    results: [],
  };

  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS trustid_ann_bench (
        id bigserial PRIMARY KEY,
        vector vector(${DIMS}) NOT NULL
      )
    `);

    for (const n of args.sizes) {
      console.error(`Bench gallery n=${n} ...`);
      await prisma.$executeRawUnsafe(`TRUNCATE trustid_ann_bench`);
      await prisma.$executeRawUnsafe(
        `DROP INDEX IF EXISTS trustid_ann_bench_hnsw`,
      );

      const tIns0 = performance.now();
      const batch = 200;
      for (let i = 0; i < n; i += batch) {
        const end = Math.min(n, i + batch);
        const values = [];
        for (let j = i; j < end; j++) {
          values.push(`('${toLiteral(unitVec(j + 1))}'::vector)`);
        }
        await prisma.$executeRawUnsafe(
          `INSERT INTO trustid_ann_bench (vector) VALUES ${values.join(",")}`,
        );
      }
      const insertMs = performance.now() - tIns0;

      const tIdx0 = performance.now();
      await prisma.$executeRawUnsafe(`
        CREATE INDEX trustid_ann_bench_hnsw
        ON trustid_ann_bench
        USING hnsw (vector vector_cosine_ops)
        WITH (m = ${args.m}, ef_construction = ${args.efConstruction})
      `);
      const indexBuildMs = performance.now() - tIdx0;

      const sizeRow = await prisma.$queryRawUnsafe(
        `SELECT pg_relation_size('trustid_ann_bench_hnsw')::bigint AS index_bytes,
                pg_total_relation_size('trustid_ann_bench')::bigint AS table_bytes`,
      );

      const perK = {};
      for (const k of args.topK) {
        const latencies = [];
        let recall1 = 0;
        for (let p = 0; p < args.probes; p++) {
          const probe = unitVec(1_000_000 + p);
          const lit = toLiteral(probe);
          const planted = await prisma.$queryRawUnsafe(
            `INSERT INTO trustid_ann_bench (vector) VALUES ('${lit}'::vector) RETURNING id`,
          );
          const plantId = Number(planted[0].id);
          await prisma.$executeRawUnsafe(
            `SELECT set_config('hnsw.ef_search', '${Math.max(args.efSearch, k)}', false)`,
          );
          const t0 = performance.now();
          const rows = await prisma.$queryRawUnsafe(
            `SELECT id::bigint AS id, (vector <=> '${lit}'::vector)::float AS distance
             FROM trustid_ann_bench
             ORDER BY vector <=> '${lit}'::vector
             LIMIT ${Math.floor(k)}`,
          );
          latencies.push(performance.now() - t0);
          if (rows.some((r) => Number(r.id) === plantId)) recall1++;
          await prisma.$executeRawUnsafe(
            `DELETE FROM trustid_ann_bench WHERE id = ${plantId}`,
          );
        }
        const sorted = [...latencies].sort((a, b) => a - b);
        const total = latencies.reduce((s, x) => s + x, 0);
        perK[`K_${k}`] = {
          queryLatencyMs: {
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
            mean: total / latencies.length,
          },
          candidateRecallAt1Approx: recall1 / args.probes,
          qps: (latencies.length * 1000) / total,
        };
      }

      report.results.push({
        gallerySize: n,
        insertMs,
        indexBuildMs,
        indexBytes: Number(sizeRow[0]?.index_bytes ?? 0),
        tableBytes: Number(sizeRow[0]?.table_bytes ?? 0),
        topK: perK,
        status: "MEASURED",
      });
    }
  } finally {
    await prisma
      .$executeRawUnsafe(`DROP TABLE IF EXISTS trustid_ann_bench`)
      .catch(() => undefined);
    await prisma.$disconnect();
  }

  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (args.out) writeFileSync(resolve(args.out), text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
