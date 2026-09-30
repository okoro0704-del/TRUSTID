/**
 * Child process for the cross-process enrollment lock proof. Each process is an
 * independent "API replica" with its own connection pool; only PostgreSQL can
 * serialize them. Prints one JSON line with the outcomes.
 *
 *   node --import tsx enrollment-lock-worker.ts <pgUrl> <table> <human> <attempts> <lock|nolock>
 */
import pg from "pg";
import {
  enrollmentLockKey,
  withPostgresAdvisoryLock,
  type AdvisoryLockClient,
} from "../../src/modules/trust-id/enrollment-serialization.js";

const [url, table, human, attemptsArg, mode] = process.argv.slice(2);
if (!url || !table || !human || !/^enroll_race_[a-z0-9_]+$/.test(table)) {
  throw new Error("usage: <pgUrl> <table> <human> <attempts> <lock|nolock>");
}
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("enrollment lock worker only runs against a local disposable database");
}

const pool = new pg.Pool({ connectionString: url, max: 8 });
const client: AdvisoryLockClient = {
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

const enrollOnce = async () => {
  const found = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE human = $1`, [human]);
  await new Promise((r) => setTimeout(r, 100));
  if (found.rows[0].n > 0) return "DUPLICATE_BLOCKED";
  await pool.query(`INSERT INTO ${table} (human) VALUES ($1)`, [human]);
  return "CREATED";
};

const attempts = Math.max(1, Number(attemptsArg) || 1);
const results = await Promise.all(
  Array.from({ length: attempts }, () =>
    mode === "nolock"
      ? enrollOnce()
      : withPostgresAdvisoryLock(client, enrollOnce, {
          acquireTimeoutMs: 30_000,
          lockKey: enrollmentLockKey("race-test-xproc", 1),
        }),
  ),
);
await pool.end();
process.stdout.write(`${JSON.stringify({ pid: process.pid, results })}\n`);
