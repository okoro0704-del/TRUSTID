#!/usr/bin/env -S npx tsx
/**
 * LAB-ONLY ANN recall governance experiment (pgvector HNSW vs exact cosine).
 *
 * Loads Assurance Lab embeddings (or a labelled synthetic fixture) into a
 * disposable local pgvector database with the production index parameters,
 * then measures each retrieval configuration with the production decision
 * code (exact rerank, threshold, ambiguity, duplicate assessment):
 *
 *   AS_IMPLEMENTED  the production call sequence (session settings issued as
 *                   separate autocommit statements, then the search)
 *   EF_<n>          ef_search applied transaction-locally with the search
 *
 * It never connects to a non-local host, never reads TrustID tables, and never
 * changes production configuration. Output is an EVALUATION_RESULT.
 *
 *   TRUSTID_BENCH_PG_URL=postgresql://postgres:***@127.0.0.1:55432/assurance_bench_lab \
 *     npx tsx scripts/assurance-lab-ann-governance.ts --source study --study-id trustid_dev_study_v1
 *   ... --source synthetic --participants 300 --holdout 60 --distractors 50000
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  buildDevelopmentStudyConfig,
  buildLabCaptureRecord,
  comparableCaptures,
  evaluateAnnRecallGovernance,
  LAB_CONSENT_VERSION,
  LAB_PRODUCTION_MODEL,
  type AnnGovernanceConfig,
  type ComparableCapture,
  type LabCaptureRecord,
  type LabGalleryEntry,
  type LabParticipant,
  type LabRetriever,
  type LabSession,
} from "@trustid/sdk/assurance-lab";
import {
  annGovernanceCohortFromStore,
  productionDuplicateAssessor,
  productionIdentificationDecider,
} from "../apps/api/src/modules/assurance-lab/service.js";
import { AssuranceLabStore } from "../apps/api/src/modules/assurance-lab/store.js";
import {
  biometricRetrievalPolicy,
  PRODUCTION_HNSW_INDEX,
} from "../apps/api/src/modules/trust-id/retrieval-policy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIMS = LAB_PRODUCTION_MODEL.embeddingDimensions;

type Args = {
  source: "study" | "synthetic";
  studyId: string;
  participants: number;
  holdout: number;
  sigma: number;
  distractors: number;
  nonFaceRows: number;
  ef: number[];
  concurrency: number[];
  topK: number;
  seed: number;
  keep: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    source: "synthetic",
    studyId: "trustid_dev_study_v1",
    participants: 200,
    holdout: 40,
    sigma: 0.8,
    distractors: 0,
    nonFaceRows: 0,
    ef: [40, 64, 128, 256, 512],
    concurrency: [1, 8],
    topK: 50,
    seed: 20260929,
    keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i]!;
    const list = () => v().split(",").map(Number).filter((x) => Number.isInteger(x) && x > 0);
    if (k === "--source") a.source = v() === "study" ? "study" : "synthetic";
    else if (k === "--study-id") a.studyId = v();
    else if (k === "--participants") a.participants = Number(v());
    else if (k === "--holdout") a.holdout = Number(v());
    else if (k === "--sigma") a.sigma = Number(v());
    else if (k === "--distractors") a.distractors = Number(v());
    else if (k === "--non-face-rows") a.nonFaceRows = Number(v());
    else if (k === "--ef") a.ef = list();
    else if (k === "--concurrency") a.concurrency = list();
    else if (k === "--top-k") a.topK = Number(v());
    else if (k === "--seed") a.seed = Number(v());
    else if (k === "--keep") a.keep = true;
  }
  return a;
}

function assertDisposable(url: string) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run with NODE_ENV=production.");
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error(`Refusing non-local host ${u.hostname}. This experiment runs only on a disposable local database.`);
  }
  const db = u.pathname.replace(/^\//, "");
  if (!/(lab|bench|disposable)/i.test(db)) {
    throw new Error(`Refusing database "${db}": name must contain lab, bench, or disposable.`);
  }
}

async function assertNoTrustIdData(client: pg.PoolClient) {
  const { rows } = await client.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE lower(table_name) IN ('user','users','biometricembedding','biometric_embeddings','session','device','trustid')`,
  );
  if (rows.length) throw new Error("Refusing: database contains application tables. Never run against TrustID data.");
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const randomUnit = (r: () => number) => unit(Array.from({ length: DIMS }, () => gauss(r)));
const jitter = (base: number[], sigma: number, r: () => number) =>
  unit(base.map((x) => x + (sigma / Math.sqrt(DIMS)) * gauss(r)));
const lit = (v: number[]) => `[${v.map((x) => x.toFixed(7)).join(",")}]`;
const parseVec = (t: string) => t.slice(1, -1).split(",").map(Number);

type Cohort = {
  evidenceClass: "REAL_HUMAN" | "SYNTHETIC_FIXTURE";
  galleryCaptures: ComparableCapture[];
  holdoutCaptures: ComparableCapture[];
  description: string;
};

/** SYNTHETIC fixture: per-participant random identity with jittered captures in two sessions. */
function syntheticCohort(a: Args): Cohort {
  const study = buildDevelopmentStudyConfig({
    studyId: "ann_governance_synthetic",
    capturesPerStep: 1,
    sampleSizeRationale: "synthetic ANN plumbing fixture",
    evidenceRetentionDays: 30,
    consentVersion: LAB_CONSENT_VERSION,
    studyVersion: "1",
  });
  const r = rng(a.seed);
  const env = {
    platform: "WEB",
    runtime: "CHROME",
    deviceClass: "LAPTOP_DESKTOP",
    cameraFacing: "USER",
    cameraOrientation: "LANDSCAPE",
    inferenceBackend: "WASM",
  } as LabSession["environment"];
  const records: LabCaptureRecord[] = [];
  const cohort = new Map<string, LabParticipant["cohort"]>();
  for (let p = 0; p < a.participants + a.holdout; p++) {
    const id = `syn_${String(p).padStart(6, "0")}`;
    cohort.set(id, p < a.participants ? "GALLERY" : "OPEN_SET_HOLDOUT");
    const base = randomUnit(r);
    const plan: Array<[string, number, Array<[string, string]>]> = [
      ["SESSION_A", 2, [["A_BASELINE", "NORMAL"], ["A_POSE", "POSE_VARIATION"]]],
      ["SESSION_B", 4, [["B_BASELINE", "REPEAT_BASELINE"], ["B_LIGHTING", "LOW_LIGHT"]]],
    ];
    for (const [key, day, steps] of plan) {
      const session: LabSession = {
        sessionId: `${id}_${key}`,
        studyId: study.studyId,
        participantId: id,
        protocolSessionKey: key,
        startedAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
        environment: env,
      };
      steps.forEach(([step, cond], n) => {
        records.push(
          buildLabCaptureRecord(study, session, {
            provenance: "SYNTHETIC",
            captureId: `${session.sessionId}_${step}`,
            capturedAt: `${session.startedAt.slice(0, 11)}00:00:0${n}.000Z`,
            protocolStepKey: step,
            conditions: [cond as never],
            model: { ...LAB_PRODUCTION_MODEL },
            quality: { decision: "PASS" },
            pad: { decision: "PASS", method: "synthetic" },
            latencyMs: { embedding: 0, total: 0 },
            embedding: jitter(base, a.sigma, r),
          }),
        );
      });
    }
  }
  const comp = comparableCaptures(records);
  return {
    evidenceClass: "SYNTHETIC_FIXTURE",
    galleryCaptures: comp.filter((c) => cohort.get(c.participantId) === "GALLERY"),
    holdoutCaptures: comp.filter((c) => cohort.get(c.participantId) === "OPEN_SET_HOLDOUT"),
    description: `SYNTHETIC: ${a.participants} gallery + ${a.holdout} holdout random identities, jitter sigma ${a.sigma}. Not biometric accuracy.`,
  };
}

/** Consented lab evidence from the local Assurance Lab store (withdrawn and expired evidence excluded). */
async function studyCohort(a: Args): Promise<Cohort> {
  const store = new AssuranceLabStore(a.studyId);
  const study = store.readStudy();
  if (!study) throw new Error(`Assurance Lab study ${a.studyId} not found.`);
  const c = await annGovernanceCohortFromStore(store, study);
  return {
    evidenceClass: c.evidenceClass,
    galleryCaptures: c.galleryCaptures,
    holdoutCaptures: c.holdoutCaptures,
    description: `Assurance Lab study ${a.studyId}: ${c.participants} active participants, provenance ${c.provenance ?? "NONE"}.`,
  };
}

type Loaded = { table: string; entries: LabGalleryEntry[] };

/**
 * One HNSW index per gallery (production parameters). Non-face rows model the
 * production table, where device-key fingerprint vectors share the same index
 * and are removed by the WHERE clause after the index scan.
 */
async function loadGallery(pool: pg.Pool, schema: string, entries: LabGalleryEntry[], a: Args): Promise<Loaded> {
  const table = `${schema}.items`;
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE ${table} (gallery_key text PRIMARY KEY, modality text NOT NULL, v vector(${DIMS}) NOT NULL)`);
    const batch = 500;
    const rows: Array<[string, string, number[]]> = entries.map((e) => [e.galleryKey, "face", e.embedding]);
    const r = rng(a.seed + 99);
    for (let i = 0; i < a.nonFaceRows; i++) rows.push([`nf_${i}`, "fingerprint", randomUnit(r)]);
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      await c.query(
        `INSERT INTO ${table} (gallery_key, modality, v)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[]::vector[])`,
        [chunk.map((x) => x[0]), chunk.map((x) => x[1]), chunk.map((x) => lit(x[2]))],
      );
    }
    await c.query(`ANALYZE ${table}`);
    await c.query("SET maintenance_work_mem = '1GB'");
    await c.query(
      `CREATE INDEX ON ${table} USING hnsw (v ${PRODUCTION_HNSW_INDEX.opclass}) WITH (m = ${PRODUCTION_HNSW_INDEX.m}, ef_construction = ${PRODUCTION_HNSW_INDEX.efConstruction})`,
    );
  } finally {
    c.release();
  }
  return { table, entries };
}

const searchSql = (table: string) =>
  `SELECT gallery_key, (v <=> $1::vector)::float8 AS d, v::text AS v
     FROM ${table}
    WHERE modality = 'face'
    ORDER BY v <=> $1::vector
    LIMIT $2`;

type Row = { gallery_key: string; d: number; v: string };
const toCandidates = (rows: Row[]) =>
  rows.map((row) => ({ galleryKey: row.gallery_key, annDistance: Number(row.d), vector: parseVec(row.v) }));

/** Production sequence: each statement autocommits on the pool, exactly like separate Prisma raw calls. */
function asImplementedRetriever(pool: pg.Pool, loaded: Loaded, declaredEf: number, timeoutMs: number): LabRetriever {
  return {
    mode: "PGVECTOR_HNSW_TOPK",
    async retrieve(probe, topK) {
      await pool.query(`SET LOCAL statement_timeout = '${timeoutMs}'`);
      await pool.query(`SELECT set_config('hnsw.ef_search', '${declaredEf}', true)`);
      const { rows } = await pool.query<Row>(searchSql(loaded.table), [lit(probe), topK]);
      return toCandidates(rows);
    },
  };
}

function transactionalRetriever(pool: pg.Pool, loaded: Loaded, ef: number, timeoutMs: number): LabRetriever {
  return {
    mode: "PGVECTOR_HNSW_TOPK",
    async retrieve(probe, topK) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL statement_timeout = '${timeoutMs}'`);
        await c.query(`SELECT set_config('hnsw.ef_search', '${ef}', true)`);
        const { rows } = await c.query<Row>(searchSql(loaded.table), [lit(probe), topK]);
        await c.query("COMMIT");
        return toCandidates(rows);
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    },
  };
}

/** What the production sequence leaves in effect for the search statement. */
async function probeAsImplementedSettings(pool: pg.Pool, declaredEf: number, timeoutMs: number) {
  const c = await pool.connect();
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(`${n.severity ?? "NOTICE"}: ${n.message}`));
  try {
    // pgvector registers hnsw.* only once its library is loaded in the session (any vector use does it).
    await c.query("SELECT '[1,0]'::vector <=> '[0,1]'::vector");
    const before = (await c.query("SELECT current_setting('hnsw.ef_search') AS ef, current_setting('statement_timeout') AS st")).rows[0];
    await c.query(`SET LOCAL statement_timeout = '${timeoutMs}'`);
    await c.query(`SELECT set_config('hnsw.ef_search', '${declaredEf}', true)`);
    const after = (await c.query("SELECT current_setting('hnsw.ef_search') AS ef, current_setting('statement_timeout') AS st")).rows[0];
    await c.query("BEGIN");
    await c.query(`SELECT set_config('hnsw.ef_search', '${declaredEf}', true)`);
    const inTx = (await c.query("SELECT current_setting('hnsw.ef_search') AS ef")).rows[0];
    await c.query("COMMIT");
    return {
      sameConnectionBestCase: true,
      databaseDefault: { hnswEfSearch: before.ef, statementTimeout: before.st },
      effectiveForSearchAsImplemented: { hnswEfSearch: after.ef, statementTimeout: after.st },
      effectiveInsideTransaction: { hnswEfSearch: inTx.ef },
      serverNotices: notices,
    };
  } finally {
    c.release();
  }
}

async function main() {
  const a = parseArgs(process.argv);
  const url = process.env.TRUSTID_BENCH_PG_URL;
  if (!url) throw new Error("Set TRUSTID_BENCH_PG_URL to a local disposable Postgres+pgvector database.");
  assertDisposable(url);
  const policy = biometricRetrievalPolicy();
  const declaredEf = policy.efSearch.declaredEffective;
  const timeoutMs = policy.annQueryTimeoutMs.declaredEffective;
  const topK = a.topK || policy.topK.effective;

  const cohort = a.source === "study" ? await studyCohort(a) : syntheticCohort(a);
  const pool = new pg.Pool({ connectionString: url, max: Math.max(...a.concurrency, 1) + 4 });
  const schema = `lab_ann_gov_${Date.now()}`;
  const env: Record<string, unknown> = {};
  let loaded: Loaded | null = null;
  try {
    const c = await pool.connect();
    try {
      await assertNoTrustIdData(c);
      await c.query("CREATE EXTENSION IF NOT EXISTS vector");
      env.postgres = (await c.query("SHOW server_version")).rows[0].server_version;
      env.pgvector = (await c.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0].extversion;
      await c.query(`CREATE SCHEMA ${schema}`);
    } finally {
      c.release();
    }
    const asImplementedSettings = await probeAsImplementedSettings(pool, declaredEf, timeoutMs);
    console.log(`as-implemented: declared ef_search=${declaredEf}, effective for search=${asImplementedSettings.effectiveForSearchAsImplemented.hnswEfSearch}`);

    const r = rng(a.seed + 7);
    const distractors: LabGalleryEntry[] = Array.from({ length: a.distractors }, (_, i) => ({
      galleryKey: `d_${i}`,
      embedding: randomUnit(r),
    }));

    const factoryFor = (make: (l: Loaded) => LabRetriever) => async (entries: LabGalleryEntry[]) => {
      if (!loaded) {
        console.log(`loading ${entries.length} gallery entries (+${a.nonFaceRows} non-face rows) and building HNSW...`);
        const t0 = Date.now();
        loaded = await loadGallery(pool, schema, entries, a);
        console.log(`gallery loaded and HNSW built in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      if (loaded.entries !== entries) throw new Error("ANN governance expects one gallery per run.");
      return make(loaded);
    };

    const configs: AnnGovernanceConfig[] = [
      {
        label: "AS_IMPLEMENTED",
        efSearch: null,
        note: `Production call sequence (declared ef_search ${declaredEf}, timeout ${timeoutMs} ms issued as separate autocommit statements).`,
        retrieverFactory: factoryFor((l) => asImplementedRetriever(pool, l, declaredEf, timeoutMs)),
      },
      ...a.ef.map((ef) => ({
        label: `EF_${ef}`,
        efSearch: ef,
        note: ef === 40 ? "pgvector default ef_search (what the as-implemented path inherits by default)." : undefined,
        retrieverFactory: factoryFor((l) => transactionalRetriever(pool, l, ef, timeoutMs)),
      })),
    ];

    const report = await evaluateAnnRecallGovernance({
      evidenceClass: cohort.evidenceClass,
      galleryCaptures: cohort.galleryCaptures,
      holdoutCaptures: cohort.holdoutCaptures,
      configs,
      decide: productionIdentificationDecider(policy.threshold.policyDistance),
      assess: productionDuplicateAssessor(policy.threshold.policyDistance),
      thresholdDistance: policy.threshold.policyDistance,
      topK,
      salt: `ann_gov_${a.seed}`,
      distractors: distractors.length
        ? { entries: distractors, distractorClass: "SYNTHETIC_RANDOM_UNIT_VECTORS" }
        : undefined,
      concurrency: a.concurrency,
      onProgress: ({ label, phase }) => console.log(`[${new Date().toISOString()}] ${label} ${phase}`),
    });

    const out = {
      label: "LAB-ONLY ANN RECALL GOVERNANCE EXPERIMENT",
      generatedAt: new Date().toISOString(),
      productionChangeApplied: false,
      cohort: cohort.description,
      environment: { ...env, node: process.version, platform: process.platform, host: "local disposable container" },
      productionPolicy: policy,
      asImplementedSettings,
      nonFaceRowsSharingIndex: a.nonFaceRows,
      args: a,
      report,
    };
    const dir = join(ROOT, "artifacts", "assurance-lab", "ann-governance");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `ann-governance-${a.source}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(out, null, 2));

    console.log(`\n${report.evidenceClass} | status ${report.status} | gallery ${report.gallery.entries} | probes mated ${report.probes.mated} non-mated ${report.probes.nonMated}`);
    for (const c of report.configs) {
      const f = (x: number | null | undefined, d = 3) => (x == null ? "  -  " : x.toFixed(d));
      const g = c.duplicateGate.returning;
      console.log(
        `${c.label.padEnd(15)} R@1 ${f(c.retrieval.recallVsExactAtK.K_1)} R@10 ${f(c.retrieval.recallVsExactAtK.K_10)} R@50 ${f(c.retrieval.recallVsExactAtK.K_50)}` +
          ` mate@50 ${f(c.retrieval.mateRecallAtK.K_50)} miss ${f(c.retrieval.candidateMissRate)} returned ${f(c.retrieval.meanCandidatesReturned, 1)}` +
          ` | FALSE CLEAR ${c.falseClear.observed}/${c.falseClear.trials} (ann ${g.annRetrievalMiss}, thr ${g.thresholdRejection}) amb ${g.ambiguity}` +
          ` | p50 ${f(c.latencyMs.p50, 1)} p95 ${f(c.latencyMs.p95, 1)} p99 ${f(c.latencyMs.p99, 1)} ms qps ${f(c.qps.sequential, 0)}` +
          ` unavailable ${c.retrieval.unavailable}` +
          c.qps.concurrent.map((q) => ` | ${q.clients} clients qps ${f(q.qps, 0)} failed ${q.failed}`).join(""),
      );
    }
    console.log(`\nwrote ${file}`);
  } finally {
    if (!a.keep) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
