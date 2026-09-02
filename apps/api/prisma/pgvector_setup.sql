-- PostgreSQL pgvector bootstrap for BiometricEmbedding AI 1:N search.
-- Requires a Postgres image that includes pgvector (Railway template: 3jJFCA).
-- Applied automatically at API startup via bootstrapPgVector(); run manually if needed.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE biometric_embeddings
  ADD COLUMN IF NOT EXISTS vector vector(512);

-- Prefer IVFFlat; if the table is empty some Postgres builds prefer HNSW.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('biometric_embeddings_vector_ivfflat', 'biometric_embeddings_vector_hnsw')
  ) THEN
    BEGIN
      CREATE INDEX biometric_embeddings_vector_ivfflat
        ON biometric_embeddings
        USING ivfflat (vector vector_cosine_ops)
        WITH (lists = 100);
    EXCEPTION WHEN others THEN
      CREATE INDEX IF NOT EXISTS biometric_embeddings_vector_hnsw
        ON biometric_embeddings
        USING hnsw (vector vector_cosine_ops);
    END;
  END IF;
END $$;
