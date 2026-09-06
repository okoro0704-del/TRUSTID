-- PostgreSQL pgvector bootstrap for BiometricEmbedding AI 1:N search.
-- Requires a Postgres image that includes pgvector (Railway template: 3jJFCA).
-- Applied automatically at API startup via bootstrapPgVector(); run manually if needed.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE biometric_embeddings
  ADD COLUMN IF NOT EXISTS vector vector(512);

-- HNSW tuned for cosine ANN (m=16, ef_construction=64)
DROP INDEX IF EXISTS biometric_embeddings_vector_ivfflat;

CREATE INDEX IF NOT EXISTS biometric_embeddings_vector_hnsw
  ON biometric_embeddings
  USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Top-K candidate generation. App applies exact cosine rerank + threshold.
-- Never use LIMIT 1 alone as the accept decision.
CREATE OR REPLACE FUNCTION search_biometric_vector_topk(
  input_vector vector(512),
  match_modality text DEFAULT 'face',
  top_k int DEFAULT 50,
  ef_search int DEFAULT 64
)
RETURNS TABLE (
  id text,
  user_id text,
  trust_id text,
  distance float
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('hnsw.ef_search', GREATEST(ef_search, top_k)::text, true);
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
  ORDER BY be.vector <=> input_vector ASC
  LIMIT GREATEST(1, LEAST(top_k, 100));
END;
$$;

-- Legacy single-row helper (ops / debug). Production identify uses Top-K + rerank.
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
  PERFORM set_config('hnsw.ef_search', '64', true);
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
  ORDER BY be.vector <=> input_vector ASC
  LIMIT 1;
END;
$$;
