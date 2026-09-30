import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENROLLMENT_LOCK_NAMESPACE,
  enrollmentLockKey,
  withPostgresAdvisoryLock,
  type AdvisoryLockClient,
} from "../src/modules/trust-id/enrollment-serialization.js";

/**
 * Real PostgreSQL concurrency proof for the enrollment lock. Runs only when
 * TRUSTID_ENROLLMENT_LOCK_PG_URL points at a local/disposable database; it
 * creates and drops its own scratch table and never touches TrustID tables.
 */
const PG_URL = process.env.TRUSTID_ENROLLMENT_LOCK_PG_URL;

function assertDisposable(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("enrollment lock Postgres test only runs against a local disposable database");
  }
}

describe.skipIf(!PG_URL)("enrollment lock on real PostgreSQL (disposable DB)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let client: AdvisoryLockClient;
  const table = `enroll_race_${process.pid}`;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: PG_URL, max: 20 });
    client = {
      async $transaction(fn) {
        const conn = await pool.connect();
        try {
          await conn.query("BEGIN");
          const out = await fn({
            $queryRawUnsafe: async (q: string, ...v: unknown[]) => (await conn.query(q, v)).rows,
          } as never);
          await conn.query("COMMIT");
          return out;
        } catch (err) {
          await conn.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          conn.release();
        }
      },
    };
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id serial PRIMARY KEY, human text NOT NULL)`);
    // Open the pool up front so connection setup does not accidentally serialize requests.
    const warm = await Promise.all(Array.from({ length: 16 }, () => pool.connect()));
    warm.forEach((c: { release(): void }) => c.release());
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.end();
    }
  });

  /** Same shape as enrollment: search (autocommit), think, create (autocommit on another connection). */
  const enrollOnce = async (human: string) => {
    const found = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE human = $1`, [human]);
    await new Promise((r) => setTimeout(r, 100));
    if (found.rows[0].n > 0) return "DUPLICATE_BLOCKED" as const;
    await pool.query(`INSERT INTO ${table} (human) VALUES ($1)`, [human]);
    return "CREATED" as const;
  };

  const count = async (human: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE human = $1`, [human])).rows[0].n as number;

  it("reproduces the race without serialization", async () => {
    await Promise.all(Array.from({ length: 12 }, () => enrollOnce("human-unlocked")));
    expect(await count("human-unlocked")).toBeGreaterThan(1);
  });

  it("advisory xact lock yields exactly one identity for simultaneous enrollments", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        withPostgresAdvisoryLock(client, () => enrollOnce("human-locked"), {
          acquireTimeoutMs: 20_000,
          lockKey: enrollmentLockKey("race-test", 1),
        }),
      ),
    );
    expect(await count("human-locked")).toBe(1);
    expect(results.filter((r) => r === "CREATED")).toHaveLength(1);
    expect(results.filter((r) => r === "DUPLICATE_BLOCKED")).toHaveLength(11);
  });

  it("releases the lock when the critical section throws", async () => {
    const key = enrollmentLockKey("race-test", 2);
    await expect(
      withPostgresAdvisoryLock(client, async () => {
        throw new Error("boom");
      }, { lockKey: key }),
    ).rejects.toThrow("boom");
    const held = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int4::oid AND objid = $2::int4::oid",
      [ENROLLMENT_LOCK_NAMESPACE, key],
    );
    expect(held.rows[0].n).toBe(0);
    expect(await withPostgresAdvisoryLock(client, async () => "ok", { lockKey: key })).toBe("ok");
  });

  /** Independent processes (API replicas) with separate pools racing on one human. */
  const raceAcrossProcesses = async (human: string, mode: "lock" | "nolock") => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const worker = fileURLToPath(new URL("./helpers/enrollment-lock-worker.ts", import.meta.url));
    const runs = Array.from(
      { length: 4 },
      () =>
        new Promise<string[]>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", worker, PG_URL!, table, human, "3", mode],
            { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("exit", (code) => {
            if (code !== 0) return reject(new Error(`worker exited ${code}: ${err}`));
            const line = out.trim().split("\n").pop()!;
            resolve((JSON.parse(line) as { results: string[] }).results);
          });
        }),
    );
    const perProcess = await Promise.all(runs);
    return perProcess.flat();
  };

  it("reproduces the race across separate processes without serialization", async () => {
    const results = await raceAcrossProcesses("human-xproc-unlocked", "nolock");
    expect(results).toHaveLength(12);
    expect(await count("human-xproc-unlocked")).toBeGreaterThan(1);
  }, 120_000);

  it("advisory xact lock yields exactly one identity across separate processes", async () => {
    const results = await raceAcrossProcesses("human-xproc-locked", "lock");
    expect(results).toHaveLength(12);
    expect(results.filter((r) => r === "CREATED")).toHaveLength(1);
    expect(results.filter((r) => r === "DUPLICATE_BLOCKED")).toHaveLength(11);
    expect(await count("human-xproc-locked")).toBe(1);
  }, 120_000);

  it("fails closed with 503 when the lock cannot be acquired in time", async () => {
    const key = enrollmentLockKey("race-test", 3);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::int4, $2::int4)", [ENROLLMENT_LOCK_NAMESPACE, key]);
      await expect(
        withPostgresAdvisoryLock(client, async () => "never", { lockKey: key, acquireTimeoutMs: 300 }),
      ).rejects.toMatchObject({ statusCode: 503, code: "BIOMETRIC_SERVICE_UNAVAILABLE" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
