/**
 * PostgreSQL Digi Core stores.
 *
 * Schema source of truth: apps/digi-rp/migrations/001_init.sql.
 * No parallel owner, replay, or session tables.
 *
 * Write failure semantics (see exchange.ts):
 * verification stays outside any database transaction.
 * Consumption, owner resolution, and session creation commit together
 * when the caller supplies runDigiCoreTransaction. A thrown error rolls
 * the whole write back, so an assertion is consumed only when the session
 * commit succeeds. A committed jti cannot be consumed again.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashSessionToken } from "./stores.js";
import type {
  DigiAuditSink,
  DigiOwner,
  DigiSession,
  ExternalIdentity,
  OwnerStore,
  ReplayStore,
  SessionStore,
} from "./types.js";

const { Pool } = pg;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

const txStorage = new AsyncLocalStorage<pg.PoolClient>();

export function loadDigiCoreSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    join(here, "../../../apps/digi-rp/migrations/001_init.sql"),
    "utf8",
  );
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function publicDbError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : "connection failed";
  const message = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
  return new Error(
    `Digi Core PostgreSQL unavailable — refusing memory fallback (${message})`,
  );
}

type OwnerRow = {
  id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

type IdentityRow = {
  id: string;
  owner_id: string;
  issuer: string;
  subject: string;
  created_at: Date;
  last_seen_at: Date;
};

type SessionRow = {
  id: string;
  owner_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
};

function mapOwner(row: OwnerRow): DigiOwner {
  return {
    id: row.id,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapIdentity(row: IdentityRow): ExternalIdentity {
  return {
    id: row.id,
    ownerId: row.owner_id,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
}

function mapSession(row: SessionRow): DigiSession {
  return {
    id: row.id,
    ownerId: row.owner_id,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

async function withClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const bound = txStorage.getStore();
  if (bound) return fn(bound);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function ensureDigiCoreSchema(
  pool: pg.Pool,
  schema = "public",
): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error("invalid Digi Core schema name");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (schema !== "public") {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    }
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(loadDigiCoreSchemaSql());
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs Digi Core writes on one checked-out connection.
 * Nested calls join the open transaction instead of committing early.
 */
export async function runDigiCoreTransaction<T>(
  pool: pg.Pool,
  fn: () => Promise<T>,
): Promise<T> {
  if (txStorage.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await txStorage.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function createPostgresOwnerStore(pool: pg.Pool): OwnerStore {
  return {
    durability: "postgres",
    async findByIssuerSubject(issuer, subject) {
      const found = await pool.query<IdentityRow>(
        `SELECT id, owner_id, issuer, subject, created_at, last_seen_at
         FROM external_identities
         WHERE issuer = $1 AND subject = $2`,
        [issuer, subject],
      );
      const row = found.rows[0];
      return row ? mapIdentity(row) : null;
    },
    async resolveOrCreate({ issuer, subject }) {
      return withClient(pool, async (client) => {
        const ownerId = newId("own");
        const identityId = newId("xid");
        await client.query(
          `INSERT INTO digi_owners (id, status, created_at, updated_at)
           VALUES ($1, 'active', NOW(), NOW())`,
          [ownerId],
        );
        const inserted = await client.query<IdentityRow>(
          `INSERT INTO external_identities
             (id, owner_id, issuer, subject, created_at, last_seen_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (issuer, subject) DO NOTHING
           RETURNING id, owner_id, issuer, subject, created_at, last_seen_at`,
          [identityId, ownerId, issuer, subject],
        );
        if ((inserted.rowCount ?? 0) === 0) {
          await client.query(`DELETE FROM digi_owners WHERE id = $1`, [ownerId]);
          const identity = await client.query<IdentityRow>(
            `UPDATE external_identities
             SET last_seen_at = NOW()
             WHERE issuer = $1 AND subject = $2
             RETURNING id, owner_id, issuer, subject, created_at, last_seen_at`,
            [issuer, subject],
          );
          const identityRow = identity.rows[0];
          if (!identityRow) {
            throw new Error("Digi owner mapping missing after unique conflict");
          }
          const owner = await client.query<OwnerRow>(
            `UPDATE digi_owners
             SET updated_at = NOW()
             WHERE id = $1
             RETURNING id, status, created_at, updated_at`,
            [identityRow.owner_id],
          );
          const ownerRow = owner.rows[0];
          if (!ownerRow) {
            throw new Error("Digi owner missing after unique conflict");
          }
          return {
            owner: mapOwner(ownerRow),
            created: false,
            identity: mapIdentity(identityRow),
          };
        }
        const owner = await client.query<OwnerRow>(
          `SELECT id, status, created_at, updated_at FROM digi_owners WHERE id = $1`,
          [ownerId],
        );
        const ownerRow = owner.rows[0];
        const identityRow = inserted.rows[0];
        if (!ownerRow || !identityRow) {
          throw new Error("Digi owner insert did not return a row");
        }
        return {
          owner: mapOwner(ownerRow),
          created: true,
          identity: mapIdentity(identityRow),
        };
      });
    },
  };
}

export function createPostgresReplayStore(pool: pg.Pool): ReplayStore {
  return {
    durability: "postgres",
    async tryConsume(input) {
      return withClient(pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO consumed_assertions (jti, issuer, subject, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (jti) DO NOTHING
           RETURNING jti`,
          [input.jti, input.issuer, input.subject, input.expiresAt],
        );
        return (inserted.rowCount ?? 0) > 0;
      });
    },
  };
}

export function createPostgresSessionStore(
  pool: pg.Pool,
  audit?: DigiAuditSink,
): SessionStore {
  let sink = audit;
  return {
    durability: "postgres",
    setAudit(next) {
      sink = next;
    },
    async create({ ownerId, ttlSeconds = 60 * 60 * 8 }) {
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashSessionToken(token);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      return withClient(pool, async (client) => {
        const id = newId("ses");
        const inserted = await client.query<SessionRow>(
          `INSERT INTO digi_sessions
             (id, owner_id, token_hash, expires_at, created_at, revoked_at)
           VALUES ($1, $2, $3, $4, NOW(), NULL)
           RETURNING id, owner_id, token_hash, expires_at, created_at, revoked_at`,
          [id, ownerId, tokenHash, expiresAt],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Digi session insert did not return a row");
        return { session: mapSession(row), token };
      });
    },
    async resolve(token) {
      const found = await pool.query<SessionRow>(
        `SELECT id, owner_id, token_hash, expires_at, created_at, revoked_at
         FROM digi_sessions
         WHERE token_hash = $1`,
        [hashSessionToken(token)],
      );
      const row = found.rows[0];
      if (!row) return null;
      const session = mapSession(row);
      if (session.revokedAt) return null;
      const expiresMs = session.expiresAt.getTime();
      if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) {
        if (Number.isFinite(expiresMs)) {
          await sink?.record("digi_session_expired", {
            ownerId: session.ownerId,
            sessionId: session.id,
          });
        }
        return null;
      }
      return session;
    },
    async revoke(sessionId) {
      const updated = await pool.query<{ id: string; owner_id: string }>(
        `UPDATE digi_sessions
         SET revoked_at = NOW()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, owner_id`,
        [sessionId],
      );
      const row = updated.rows[0];
      if (!row) return;
      await sink?.record("digi_session_revoked", {
        ownerId: row.owner_id,
        sessionId: row.id,
      });
    },
  };
}

export type DigiCoreHandle = {
  owners: OwnerStore;
  replay: ReplayStore;
  sessions: SessionStore;
  runWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  pool: pg.Pool;
  close: () => Promise<void>;
};

export async function openPostgresDigiCore(
  databaseUrl: string,
  options?: { schema?: string },
): Promise<DigiCoreHandle> {
  const schema = options?.schema ?? "public";
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error("invalid Digi Core schema name");
  }
  if (schema !== "public") {
    const bootstrap = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    } catch (err) {
      await bootstrap.end().catch(() => undefined);
      throw publicDbError(err);
    }
    await bootstrap.end();
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 24,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema}`,
  });
  try {
    await ensureDigiCoreSchema(pool, schema);
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw publicDbError(err);
  }
  return {
    owners: createPostgresOwnerStore(pool),
    replay: createPostgresReplayStore(pool),
    sessions: createPostgresSessionStore(pool),
    runWrite: (fn) => runDigiCoreTransaction(pool, fn),
    pool,
    close: () => pool.end(),
  };
}
