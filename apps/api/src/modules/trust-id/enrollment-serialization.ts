/**
 * Serializes the biometric enrollment critical section:
 *   duplicate search -> identity creation -> face template write.
 *
 * Invariant: two concurrent enrollments of the same human must not both pass
 * the duplicate search before either template is visible, or two identities
 * are created. Any two faces may belong to the same human, so the section is
 * serialized per face model, not per identity.
 *
 * PostgreSQL (production): a transaction-scoped advisory lock
 * (pg_try_advisory_xact_lock) held by a dedicated interactive transaction. The
 * lock is database-wide, so it holds across API processes and replicas, and it
 * is released automatically on commit, rollback, or connection loss. The
 * critical section's writes autocommit on other pool connections before the
 * lock is released, so the next holder's search sees them. Acquisition is a
 * non-blocking try-lock with bounded retry so waiting requests do not pin pool
 * connections; on deadline the enrollment fails closed (503).
 *
 * SQLite (local development/tests only): there is no cross-process lock
 * primitive available through the shared client, so a single-process queue is
 * used and reported as SINGLE_PROCESS_DEV_ONLY. It is not a production
 * mechanism.
 */
import { BIOMETRIC_AI_MODEL_NAME, BIOMETRIC_AI_MODEL_VERSION } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { isPostgresDatabase } from "../../lib/pgvector.js";

export type EnrollmentSerializationBackend = "POSTGRES_ADVISORY_XACT" | "SINGLE_PROCESS_DEV_ONLY";

/** Advisory lock namespace (int4): ASCII "TIDE" (TrustID Enrollment). */
export const ENROLLMENT_LOCK_NAMESPACE = 0x54494445 | 0;

function int4Hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function enrollmentLockKey(
  modelName = BIOMETRIC_AI_MODEL_NAME,
  modelVersion = BIOMETRIC_AI_MODEL_VERSION,
): number {
  return int4Hash(`face:${modelName}:${modelVersion}`);
}

export function enrollmentSerializationBackend(): EnrollmentSerializationBackend {
  return isPostgresDatabase() ? "POSTGRES_ADVISORY_XACT" : "SINGLE_PROCESS_DEV_ONLY";
}

export type EnrollmentLockOptions = {
  /** Max time to wait for the lock before failing closed. */
  acquireTimeoutMs?: number;
  /** Max time the critical section may hold the lock. */
  holdTimeoutMs?: number;
  lockKey?: number;
};

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function enrollmentLockUnavailableError(): Error {
  return Object.assign(
    new Error("Biometric enrollment is busy; enrollment failed closed. Retry shortly."),
    { statusCode: 503, code: "BIOMETRIC_SERVICE_UNAVAILABLE", reason: "enrollment_lock_timeout" },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal client surface so the Postgres path can be exercised against any database. */
export type AdvisoryLockClient = {
  $transaction<T>(
    fn: (tx: { $queryRawUnsafe<R = unknown>(query: string, ...values: unknown[]): Promise<R> }) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
};

export async function withPostgresAdvisoryLock<T>(
  client: AdvisoryLockClient,
  critical: () => Promise<T>,
  options: EnrollmentLockOptions = {},
): Promise<T> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? envMs("TRUSTID_ENROLLMENT_LOCK_WAIT_MS", 15_000);
  const holdTimeoutMs = options.holdTimeoutMs ?? envMs("TRUSTID_ENROLLMENT_LOCK_HOLD_MS", 60_000);
  const key = options.lockKey ?? enrollmentLockKey();
  const deadline = Date.now() + acquireTimeoutMs;
  let backoff = 10;
  for (;;) {
    const outcome = await client.$transaction(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
          "SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS locked",
          ENROLLMENT_LOCK_NAMESPACE,
          key,
        );
        if (!rows[0]?.locked) return { acquired: false as const };
        return { acquired: true as const, value: await critical() };
      },
      { maxWait: Math.max(1_000, acquireTimeoutMs), timeout: holdTimeoutMs },
    );
    if (outcome.acquired) return outcome.value;
    if (Date.now() >= deadline) throw enrollmentLockUnavailableError();
    await sleep(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, 250);
  }
}

let devQueue: Promise<unknown> = Promise.resolve();

async function withSingleProcessDevQueue<T>(critical: () => Promise<T>): Promise<T> {
  const run = devQueue.then(critical, critical);
  devQueue = run.catch(() => undefined);
  return run;
}

/** Run the enrollment critical section under the durable enrollment lock. */
export async function withBiometricEnrollmentLock<T>(
  critical: () => Promise<T>,
  options: EnrollmentLockOptions = {},
): Promise<T> {
  if (enrollmentSerializationBackend() === "POSTGRES_ADVISORY_XACT") {
    return withPostgresAdvisoryLock(prisma as unknown as AdvisoryLockClient, critical, options);
  }
  return withSingleProcessDevQueue(critical);
}
