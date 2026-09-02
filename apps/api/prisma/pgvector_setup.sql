-- PostgreSQL pgvector bootstrap for BiometricEmbedding AI 1:N search.
-- Applied automatically at API startup via bootstrapPgVector(); run manually if needed.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE biometric_embeddings
  ADD COLUMN IF NOT EXISTS vector vector(512);

CREATE INDEX IF NOT EXISTS biometric_embeddings_vector_ivfflat
  ON biometric_embeddings
  USING ivfflat (vector vector_cosine_ops)
  WITH (lists = 100);
