-- Digi RP authority schema (Phase T3). Additive — never force-reset.

CREATE TABLE IF NOT EXISTS authority_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  conditions_json TEXT NOT NULL DEFAULT '{}',
  approval_mode TEXT NOT NULL,
  consequence TEXT NOT NULL DEFAULT 'MEDIUM',
  one_time INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  grant_version INTEGER NOT NULL DEFAULT 1,
  parent_grant_id TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_grants_owner ON authority_grants(owner_id, status);

CREATE TABLE IF NOT EXISTS authority_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  consequence TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  step_up_provided INTEGER NOT NULL DEFAULT 0,
  grant_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_requests_owner ON authority_requests(owner_id, status);

CREATE TABLE IF NOT EXISTS authority_consumptions (
  jti TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authority_audit (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  owner_id TEXT,
  actor_type TEXT,
  actor_id TEXT,
  grant_id TEXT,
  request_id TEXT,
  jti TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
