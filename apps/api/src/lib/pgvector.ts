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
 * Safe to call repeatedly; no-op on SQLite.
 */
export async function bootstrapPgVector(): Promise<boolean> {
  if (!isPostgresDatabase()) {
    pgVectorReady = false;
    return false;
  }
  if (pgVectorReady !== null) return pgVectorReady;

  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE biometric_embeddings
      ADD COLUMN IF NOT EXISTS vector vector(512)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS biometric_embeddings_vector_ivfflat
      ON biometric_embeddings
      USING ivfflat (vector vector_cosine_ops)
      WITH (lists = 100)
    `);

    pgVectorReady = true;
    return true;
  } catch (err) {
    console.warn("[pgvector] bootstrap skipped:", err instanceof Error ? err.message : err);
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
