-- Enable Vector Extension and Create Portal Schema
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS portal;

-- Master Trust ID Registry
CREATE TABLE IF NOT EXISTS portal.trust_id_registry (
    trust_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 512D Facial Vector Store
CREATE TABLE IF NOT EXISTS portal.biometric_vectors (
    trust_id UUID PRIMARY KEY REFERENCES portal.trust_id_registry(trust_id) ON DELETE CASCADE,
    face_embedding vector(512) NOT NULL,
    liveness_score NUMERIC(5, 4) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- High-Performance HNSW Index for 1:N Cosine Similarity
CREATE INDEX IF NOT EXISTS idx_biometric_vectors_hnsw
ON portal.biometric_vectors
USING hnsw (face_embedding vector_cosine_ops);

-- Device Registry & Approval Tracking
CREATE TABLE IF NOT EXISTS portal.trusted_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trust_id UUID REFERENCES portal.trust_id_registry(trust_id) ON DELETE CASCADE,
    device_fingerprint VARCHAR(255) NOT NULL,
    device_name VARCHAR(100),
    is_master_device BOOLEAN DEFAULT FALSE,
    has_fingerprint_backup BOOLEAN DEFAULT FALSE,
    status VARCHAR(50) DEFAULT 'ACTIVE', -- ACTIVE, PENDING_APPROVAL, REVOKED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_device_per_trust UNIQUE (trust_id, device_fingerprint)
);

-- Cross-Device Master Approval Requests
CREATE TABLE IF NOT EXISTS portal.master_approval_requests (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trust_id UUID REFERENCES portal.trust_id_registry(trust_id) ON DELETE CASCADE,
    requesting_device_fingerprint VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, EXPIRED
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
