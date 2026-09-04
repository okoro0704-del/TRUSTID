-- PostgreSQL pgvector bootstrap for BiometricEmbedding AI 1:N search.
-- Requires a Postgres image that includes pgvector (Railway template: 3jJFCA).
-- Applied automatically at API startup via bootstrapPgVector(); run manually if needed.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE biometric_embeddings
  ADD COLUMN IF NOT EXISTS vector vector(512);

-- HNSW tuned for sub-10ms cosine ANN (m=16, ef_construction=64)
DROP INDEX IF EXISTS biometric_embeddings_vector_ivfflat;

CREATE INDEX IF NOT EXISTS biometric_embeddings_vector_hnsw
  ON biometric_embeddings
  USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

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
