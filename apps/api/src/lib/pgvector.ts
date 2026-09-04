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
 * Enable pgvector + HNSW-tuned 512-D index for sub-10ms 1:N face search.
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

    // Prefer HNSW (m=16, ef_construction=64) for low-latency cosine ANN.
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'biometric_embeddings_vector_hnsw'
        ) THEN
          CREATE INDEX biometric_embeddings_vector_hnsw
            ON biometric_embeddings
            USING hnsw (vector vector_cosine_ops)
            WITH (m = 16, ef_construction = 64);
        END IF;
      END $$;
    `);

    // Drop legacy IVFFlat if both exist — HNSW is the fast path.
    await prisma.$executeRawUnsafe(`
      DROP INDEX IF EXISTS biometric_embeddings_vector_ivfflat
    `);

    // Ultra-fast 1:N lookup with explicit HNSW search depth.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION search_biometric_vector(
        input_vector vector(512),
        match_modality text DEFAULT 'face',
        max_distance float DEFAULT 0.35
      )
      RETURNS TABLE (
        id text,
        user_id text,
        trust_id text,
        distance float
      )
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM set_config('hnsw.ef_search', '40', true);
        RETURN QUERY
        SELECT
          be.id::text,
          be.user_id::text,
          be.trust_id::text,
          (be.vector <=> input_vector)::float AS distance
        FROM biometric_embeddings be
        WHERE be.modality = match_modality
          AND be.status = 'active'
          AND be.vector IS NOT NULL
          AND (be.vector <=> input_vector) <= max_distance
        ORDER BY be.vector <=> input_vector ASC
        LIMIT 1;
      END;
      $$;
    `);

    const version = await prisma.$queryRawUnsafe<Array<{ extversion: string }>>(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );

    pgVectorReady = true;
    console.log(
      `[pgvector] ready — vector@${version[0]?.extversion ?? "unknown"}, HNSW(m=16,ef_c=64) + search_biometric_vector()`,
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
