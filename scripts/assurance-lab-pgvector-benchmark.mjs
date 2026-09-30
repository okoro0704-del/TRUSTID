#!/usr/bin/env node
/**
 * SYNTHETIC INFRASTRUCTURE BENCHMARK - pgvector HNSW for the Assurance Lab.
 *
 * Measures search infrastructure only (build time, size, latency, QPS,
 * concurrency, recall vs exact). Vectors are random unit vectors generated
 * server-side; nothing here is biometric accuracy evidence.
 *
 * Safety: refuses any non-local host, any database whose name does not contain
 * lab/bench/disposable, and any database that contains TrustID tables. It
 * creates a private schema and drops it afterwards.
 *
 * Usage:
 *   TRUSTID_BENCH_PG_URL=postgresql://user:pass@127.0.0.1:55432/assurance_lab \
 *     node scripts/assurance-lab-pgvector-benchmark.mjs --sizes 10000,100000
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIMS = 512;
const HNSW = { m: 16, efConstruction: 64 };
const EF_SEARCH_DEFAULT = 64;

function parseArgs(argv) {
  const out = {
    sizes: [10_000, 100_000],
    topK: [10, 50],
    exactQueries: 50,
    mateQueries: 200,
    latencyQueries: 300,
    concurrency: [1, 4, 16],
    queriesPerLevel: 400,
    mateNoise: 0.45,
    maintenanceWorkMem: "1GB",
    efSearchSweep: [],
    keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--sizes") out.sizes = next().split(",").map(Number);
    else if (a === "--top-k") out.topK = next().split(",").map(Number);
    else if (a === "--exact-queries") out.exactQueries = Number(next());
    else if (a === "--mate-queries") out.mateQueries = Number(next());
    else if (a === "--latency-queries") out.latencyQueries = Number(next());
    else if (a === "--concurrency") out.concurrency = next().split(",").map(Number);
    else if (a === "--queries-per-level") out.queriesPerLevel = Number(next());
    else if (a === "--maintenance-work-mem") out.maintenanceWorkMem = next();
    else if (a === "--ef-search-sweep") out.efSearchSweep = next().split(",").map(Number).filter((x) => Number.isInteger(x) && x > 0);
    else if (a === "--keep") out.keep = true;
  }
  return out;
}

function assertDisposableUrl(url) {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error(`Refusing non-local benchmark host ${u.hostname}. Benchmarks run only on a disposable local database.`);
  }
  const db = u.pathname.replace(/^\//, "");
  if (!/(lab|bench|disposable)/i.test(db)) {
    throw new Error(`Refusing database "${db}": name must contain lab, bench, or disposable.`);
  }
}

async function assertNoTrustIdData(client) {
  const { rows } = await client.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE lower(table_name) IN ('user', 'users', 'biometricembedding', 'biometric_embeddings', 'session', 'device', 'trustid')`,
  );
  if (rows.length) {
    throw new Error(
      `Refusing: database contains application tables (${rows.map((r) => `${r.table_schema}.${r.table_name}`).join(", ")}). Never benchmark against TrustID data.`,
    );
  }
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function latencyStats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    p99: pct(s, 0.99),
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
}
function unit(v) {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
}
const lit = (v) => `[${v.map((x) => x.toFixed(7)).join(",")}]`;
const parseVec = (t) => t.slice(1, -1).split(",").map(Number);

async function benchmarkSize(pool, schema, n, cfg, log) {
  const table = `${schema}.items_${n}`;
  const c = await pool.connect();
  const result = { vectors: n, dims: DIMS, hnsw: { ...HNSW, efSearch: {} } };
  try {
    await c.query(`CREATE TABLE ${table} (id bigint PRIMARY KEY, v vector(${DIMS}) NOT NULL)`);
    const t0 = performance.now();
    const batch = 25_000;
    for (let start = 1; start <= n; start += batch) {
      const end = Math.min(n, start + batch - 1);
      await c.query(
        `INSERT INTO ${table} (id, v)
           SELECT g, l2_normalize(ARRAY(SELECT random() - 0.5 + 0 * g FROM generate_series(1, ${DIMS}))::vector)
             FROM generate_series($1::bigint, $2::bigint) g`,
        [start, end],
      );
      log(`  inserted ${end}/${n}`);
    }
    result.insertSeconds = (performance.now() - t0) / 1000;
    await c.query(`ANALYZE ${table}`);

    await c.query(`SET maintenance_work_mem = '${cfg.maintenanceWorkMem}'`);
    const parallel = await c.query("SHOW max_parallel_maintenance_workers");
    const t1 = performance.now();
    await c.query(
      `CREATE INDEX ${`items_${n}_hnsw`} ON ${table} USING hnsw (v vector_cosine_ops) WITH (m = ${HNSW.m}, ef_construction = ${HNSW.efConstruction})`,
    );
    result.indexBuildSeconds = (performance.now() - t1) / 1000;
    result.buildSettings = {
      maintenanceWorkMem: cfg.maintenanceWorkMem,
      maxParallelMaintenanceWorkers: Number(parallel.rows[0].max_parallel_maintenance_workers),
    };
    const size = await c.query(
      `SELECT pg_relation_size($1::regclass) AS heap, pg_indexes_size($1::regclass) AS idx, pg_total_relation_size($1::regclass) AS total`,
      [table],
    );
    result.sizeBytes = {
      heap: Number(size.rows[0].heap),
      indexes: Number(size.rows[0].idx),
      total: Number(size.rows[0].total),
    };
    result.sizeBytes.perVectorTotal = result.sizeBytes.total / n;
    log(`  index built in ${result.indexBuildSeconds.toFixed(1)}s; total ${(result.sizeBytes.total / 1e6).toFixed(1)} MB`);

    const annQuery = (k) =>
      `SELECT id, v <=> $1::vector AS d, v::text AS v FROM ${table} ORDER BY v <=> $1::vector LIMIT ${k}`;
    const idQuery = (k) => `SELECT id FROM ${table} ORDER BY v <=> $1::vector LIMIT ${k}`;
    const withEf = async (client, k, fn, efOverride) => {
      const ef = efOverride ?? Math.max(EF_SEARCH_DEFAULT, k);
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('hnsw.ef_search', '${ef}', true)`);
        return await fn();
      } finally {
        await client.query("COMMIT");
      }
    };

    // Recall of HNSW Top-K against exact Top-K for random (non-mated) probes.
    const r = rng(n);
    result.recallVsExact = {};
    const probes = Array.from({ length: cfg.exactQueries }, () => unit(Array.from({ length: DIMS }, () => gauss(r))));
    for (const k of cfg.topK) {
      result.hnsw.efSearch[`K_${k}`] = Math.max(EF_SEARCH_DEFAULT, k);
      let hit = 0;
      const exactMs = [];
      for (const p of probes) {
        const ann = await withEf(c, k, () => c.query(idQuery(k), [lit(p)]));
        await c.query("BEGIN");
        await c.query("SET LOCAL enable_indexscan = off");
        await c.query("SET LOCAL enable_bitmapscan = off");
        const te = performance.now();
        const exact = await c.query(idQuery(k), [lit(p)]);
        exactMs.push(performance.now() - te);
        await c.query("COMMIT");
        const truth = new Set(exact.rows.map((x) => String(x.id)));
        hit += ann.rows.filter((x) => truth.has(String(x.id))).length;
      }
      result.recallVsExact[`K_${k}`] = hit / (probes.length * k);
      result.exactScanLatencyMs = latencyStats(exactMs);
      log(`  recall@${k} vs exact = ${result.recallVsExact[`K_${k}`].toFixed(4)}`);
    }

    // Mated probes: perturbed stored vectors (a re-capture proxy); is the source in Top-K?
    const ids = Array.from({ length: cfg.mateQueries }, () => 1 + Math.floor(r() * n));
    const src = await c.query(`SELECT id, v::text AS v FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
    const mates = src.rows.map((row) => {
      const v = parseVec(row.v);
      const noise = unit(Array.from({ length: DIMS }, () => gauss(r))).map((x) => x * cfg.mateNoise);
      return { id: String(row.id), probe: unit(v.map((x, i) => x + noise[i])) };
    });
    const kMax = Math.max(...cfg.topK);
    const mateRank = [];
    let mateDist = 0;
    for (const m of mates) {
      const ann = await withEf(c, kMax, () => c.query(annQuery(kMax), [lit(m.probe)]));
      const idx = ann.rows.findIndex((x) => String(x.id) === m.id);
      mateRank.push(idx < 0 ? Infinity : idx + 1);
      if (idx >= 0) mateDist += Number(ann.rows[idx].d);
    }
    result.mateRecall = Object.fromEntries(
      [1, ...cfg.topK].map((k) => [`K_${k}`, mateRank.filter((x) => x <= k).length / (mateRank.length || 1)]),
    );
    result.mateMeanDistance = mateDist / (mateRank.filter(Number.isFinite).length || 1);
    log(`  mate recall ${JSON.stringify(result.mateRecall)}`);

    // Lab-only ef_search sensitivity on the same index. Production keeps max(64, topK).
    if (cfg.efSearchSweep.length) {
      result.efSearchSweep = [];
      const sweepLat = Array.from({ length: 100 }, () => lit(unit(Array.from({ length: DIMS }, () => gauss(r)))));
      for (const ef of cfg.efSearchSweep) {
        const efK = Math.max(ef, kMax);
        let mateHits = 0;
        for (const m of mates) {
          const ann = await withEf(c, kMax, () => c.query(idQuery(kMax), [lit(m.probe)]), efK);
          if (ann.rows.some((x) => String(x.id) === m.id)) mateHits++;
        }
        let exactHits = 0;
        for (const p of probes) {
          const ann = await withEf(c, kMax, () => c.query(idQuery(kMax), [lit(p)]), efK);
          await c.query("BEGIN");
          await c.query("SET LOCAL enable_indexscan = off");
          await c.query("SET LOCAL enable_bitmapscan = off");
          const exact = await c.query(idQuery(kMax), [lit(p)]);
          await c.query("COMMIT");
          const truth = new Set(exact.rows.map((x) => String(x.id)));
          exactHits += ann.rows.filter((x) => truth.has(String(x.id))).length;
        }
        const lat = [];
        for (const p of sweepLat) {
          const ts = performance.now();
          await withEf(c, kMax, () => c.query(annQuery(kMax), [p]), efK);
          lat.push(performance.now() - ts);
        }
        const row = {
          efSearch: efK,
          topK: kMax,
          mateRecallAtTopK: mateHits / (mates.length || 1),
          recallVsExactAtTopK: exactHits / (probes.length * kMax),
          latencyMs: latencyStats(lat),
        };
        result.efSearchSweep.push(row);
        log(
          `  ef_search=${efK}: mate recall@${kMax}=${row.mateRecallAtTopK.toFixed(3)} recall@${kMax} vs exact=${row.recallVsExactAtTopK.toFixed(3)} p50=${row.latencyMs.p50.toFixed(1)}ms p95=${row.latencyMs.p95.toFixed(1)}ms`,
        );
      }
    }

    // Single-client latency at the production default Top-K (50), vectors returned for rerank.
    const kLat = cfg.topK.includes(50) ? 50 : kMax;
    const latProbes = Array.from({ length: cfg.latencyQueries }, () => lit(unit(Array.from({ length: DIMS }, () => gauss(r)))));
    const lat = [];
    for (const p of latProbes) {
      const ts = performance.now();
      await withEf(c, kLat, () => c.query(annQuery(kLat), [p]));
      lat.push(performance.now() - ts);
    }
    result.latencyMs = { topK: kLat, efSearch: Math.max(EF_SEARCH_DEFAULT, kLat), ...latencyStats(lat) };
    log(`  latency p50=${result.latencyMs.p50.toFixed(2)}ms p95=${result.latencyMs.p95.toFixed(2)}ms p99=${result.latencyMs.p99.toFixed(2)}ms`);
  } finally {
    c.release();
  }

  // Concurrency / throughput.
  result.concurrency = [];
  const r2 = rng(n + 7);
  const kLat = result.latencyMs.topK;
  const probeLits = Array.from({ length: 200 }, () => lit(unit(Array.from({ length: DIMS }, () => gauss(r2)))));
  for (const level of cfg.concurrency) {
    const per = Math.ceil(cfg.queriesPerLevel / level);
    const all = [];
    const t = performance.now();
    await Promise.all(
      Array.from({ length: level }, async (_, w) => {
        const client = await pool.connect();
        try {
          for (let i = 0; i < per; i++) {
            const ts = performance.now();
            await client.query("BEGIN");
            await client.query(`SELECT set_config('hnsw.ef_search', '${Math.max(EF_SEARCH_DEFAULT, kLat)}', true)`);
            await client.query(
              `SELECT id, v <=> $1::vector AS d, v::text AS v FROM ${table} ORDER BY v <=> $1::vector LIMIT ${kLat}`,
              [probeLits[(w * per + i) % probeLits.length]],
            );
            await client.query("COMMIT");
            all.push(performance.now() - ts);
          }
        } finally {
          client.release();
        }
      }),
    );
    const seconds = (performance.now() - t) / 1000;
    result.concurrency.push({ clients: level, queries: all.length, qps: all.length / seconds, ...latencyStats(all) });
    log(`  concurrency ${level}: ${(all.length / seconds).toFixed(1)} QPS`);
  }

  if (!cfg.keep) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  return result;
}

async function main() {
  const cfg = parseArgs(process.argv);
  const url = process.env.TRUSTID_BENCH_PG_URL;
  if (!url) throw new Error("Set TRUSTID_BENCH_PG_URL to a local disposable Postgres+pgvector database.");
  assertDisposableUrl(url);
  const pool = new pg.Pool({ connectionString: url, max: Math.max(...cfg.concurrency) + 2 });
  const log = (m) => console.log(m);
  const schema = `lab_bench_${Date.now()}`;
  const env = {};
  try {
    const c = await pool.connect();
    try {
      await assertNoTrustIdData(c);
      await c.query("CREATE EXTENSION IF NOT EXISTS vector");
      env.postgres = (await c.query("SHOW server_version")).rows[0].server_version;
      env.pgvector = (await c.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0].extversion;
      env.sharedBuffers = (await c.query("SHOW shared_buffers")).rows[0].shared_buffers;
      await c.query(`CREATE SCHEMA ${schema}`);
    } finally {
      c.release();
    }
    const results = [];
    for (const n of cfg.sizes) {
      log(`== ${n.toLocaleString()} vectors`);
      results.push(await benchmarkSize(pool, schema, n, cfg, log));
    }
    const report = {
      label: "SYNTHETIC INFRASTRUCTURE BENCHMARK",
      notBiometricAccuracy: true,
      generatedAt: new Date().toISOString(),
      environment: { ...env, node: process.version, platform: process.platform, host: "local disposable container" },
      vectorModel: "uniform random unit vectors, 512-D (server-side random(); no real faces)",
      productionIndexParameters: { ...HNSW, efSearch: "max(64, topK)", metric: "vector_cosine_ops" },
      config: cfg,
      results,
    };
    const dir = join(ROOT, "artifacts", "assurance-lab", "benchmarks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `pgvector-${cfg.sizes.join("-")}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    log(`wrote ${file}`);
  } finally {
    if (!cfg.keep) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
