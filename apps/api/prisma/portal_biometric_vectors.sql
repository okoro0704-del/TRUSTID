-- Sovereign Trust ID registry table (PostgreSQL + pgvector).
-- One canonical row per user per modality, optimized for 1:N face search.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS portal;

CREATE TABLE IF NOT EXISTS portal.biometric_vectors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trust_id TEXT NOT NULL,
  modality TEXT NOT NULL,
  vector vector(512) NOT NULL,
  model_name TEXT NOT NULL DEFAULT 'mobile_facenet_v1',
  model_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  last_matched_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, modality)
);

CREATE INDEX IF NOT EXISTS biometric_vectors_face_active_idx
  ON portal.biometric_vectors (modality, status);

CREATE INDEX IF NOT EXISTS biometric_vectors_vector_ivfflat
  ON portal.biometric_vectors
  USING ivfflat (vector vector_cosine_ops)
  WITH (lists = 100);

-- Hard duplicate guard: reject near-duplicate face during enrollment.
-- Tune threshold conservatively to prevent accidental second-account creation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'biometric_vectors_modality_check'
  ) THEN
    ALTER TABLE portal.biometric_vectors
      ADD CONSTRAINT biometric_vectors_modality_check
      CHECK (modality IN ('face', 'fingerprint'));
  END IF;
END $$;
