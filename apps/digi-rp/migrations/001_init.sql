-- Digi RP durable schema (Phase T2). Additive — never force-reset.
-- Apply on Digi's own database (not TrustID).

CREATE TABLE IF NOT EXISTS digi_owners (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES digi_owners(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS external_identities_owner_id_idx ON external_identities(owner_id);

CREATE TABLE IF NOT EXISTS consumed_assertions (
  jti TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS consumed_assertions_expires_at_idx ON consumed_assertions(expires_at);

CREATE TABLE IF NOT EXISTS digi_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES digi_owners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS digi_sessions_owner_id_idx ON digi_sessions(owner_id);
