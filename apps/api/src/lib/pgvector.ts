import { prisma } from "../db/client.js";

let pgVectorReady: boolean | null = null;

export function isPostgresDatabase(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return /^postgres(ql)?:\/\//i.test(url);
}

/** Format a float array for pgvector literal: '[0.1,0.2,...]' */
export function toPgVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number(v.toFixed(8))).join(",")}]`;
}

/**
 * Enable pgvector extension and sync vector(512) column on PostgreSQL.
 * Requires a Postgres image that ships pgvector (Railway template code: 3jJFCA).
 * Safe to call repeatedly; no-op on SQLite.
 */
export async function bootstrapPgVector(): Promise<boolean> {
  if (!isPostgresDatabase()) {
    pgVectorReady = false;
    console.log("[pgvector] skipped — not a PostgreSQL DATABASE_URL");
    return false;
  }
  if (pgVectorReady !== null) return pgVectorReady;

  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

    // Prisma creates the table; ensure it exists before ALTER (boot order: db push then start).
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF to_regclass('public.biometric_embeddings') IS NULL THEN
          RAISE EXCEPTION 'biometric_embeddings table missing — run prisma db push before start';
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE biometric_embeddings
      ADD COLUMN IF NOT EXISTS vector vector(512)
    `);

    // IVFFlat needs at least some rows for ideal lists; create when possible.
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'biometric_embeddings_vector_ivfflat'
        ) THEN
          BEGIN
            CREATE INDEX biometric_embeddings_vector_ivfflat
              ON biometric_embeddings
              USING ivfflat (vector vector_cosine_ops)
              WITH (lists = 100);
          EXCEPTION WHEN others THEN
            -- Empty tables can fail IVFFlat on some versions; fall back to HNSW.
            CREATE INDEX IF NOT EXISTS biometric_embeddings_vector_hnsw
              ON biometric_embeddings
              USING hnsw (vector vector_cosine_ops);
          END;
        END IF;
      END $$;
    `);

    const version = await prisma.$queryRawUnsafe<Array<{ extversion: string }>>(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );

    pgVectorReady = true;
    console.log(
      `[pgvector] ready — extension vector@${version[0]?.extversion ?? "unknown"}, column vector(512) active`,
    );
    return true;
  } catch (err) {
    console.warn(
      "[pgvector] bootstrap failed — AI 1:N will use in-memory fallback until a pgvector Postgres is linked:",
      err instanceof Error ? err.message : err,
    );
    console.warn(
      "[pgvector] Deploy Railway template https://railway.com/deploy/3jJFCA and set DATABASE_URL to that service.",
    );
    pgVectorReady = false;
    return false;
  }
}

export async function isPgVectorEnabled(): Promise<boolean> {
  if (pgVectorReady !== null) return pgVectorReady;
  return bootstrapPgVector();
}

/** Sync pgvector column using sanitized numeric literal (no ORM vector type on SQLite). */
export async function syncEmbeddingVectorColumn(
  id: string,
  vector: number[],
): Promise<void> {
  if (!(await isPgVectorEnabled())) return;
  const literal = toPgVectorLiteral(vector);
  await prisma.$executeRawUnsafe(
    `UPDATE biometric_embeddings SET vector = '${literal}'::vector WHERE id = '${id}'`,
  );
}
