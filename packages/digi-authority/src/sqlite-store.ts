import { DatabaseSync } from "node:sqlite";
import type {
  ActorType,
  ApprovalMode,
  AuthorityConditions,
  AuthorityGrant,
  AuthorityLimits,
  AuthorityRequest,
  AuthorityStatus,
  ConsequenceLevel,
} from "./types.js";
import type {
  AuditEvent,
  AuthorityStore,
  CreateGrantInput,
  CreateRequestInput,
} from "./stores.js";

export const AUTHORITY_SQL_SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_auth_grants_owner ON authority_grants(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_requests_owner ON authority_requests(owner_id, status);
`;

type GrantRow = {
  id: string;
  owner_id: string;
  actor_type: string;
  actor_id: string;
  audience: string;
  actions_json: string;
  resources_json: string;
  limits_json: string;
  conditions_json: string;
  approval_mode: string;
  consequence: string;
  one_time: number;
  valid_from: string;
  valid_until: string;
  status: string;
  policy_version: number;
  grant_version: number;
  parent_grant_id: string | null;
  usage_count: number;
  created_at: string;
  revoked_at: string | null;
};

type RequestRow = {
  id: string;
  owner_id: string;
  actor_type: string;
  actor_id: string;
  audience: string;
  action: string;
  resource: string;
  consequence: string;
  decision: string;
  status: string;
  step_up_provided: number;
  grant_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

function mapGrant(row: GrantRow): AuthorityGrant {
  return {
    id: row.id,
    ownerId: row.owner_id,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    audience: row.audience,
    actions: JSON.parse(row.actions_json) as string[],
    resources: JSON.parse(row.resources_json) as string[],
    limits: JSON.parse(row.limits_json) as AuthorityLimits,
    conditions: JSON.parse(row.conditions_json) as AuthorityConditions,
    approvalMode: row.approval_mode as ApprovalMode,
    consequence: row.consequence as ConsequenceLevel,
    oneTime: row.one_time === 1,
    validFrom: new Date(row.valid_from),
    validUntil: new Date(row.valid_until),
    status: row.status as AuthorityStatus,
    policyVersion: row.policy_version,
    grantVersion: row.grant_version,
    parentGrantId: row.parent_grant_id,
    usageCount: row.usage_count,
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function mapRequest(row: RequestRow): AuthorityRequest {
  return {
    id: row.id,
    ownerId: row.owner_id,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    audience: row.audience,
    action: row.action,
    resource: row.resource,
    consequence: row.consequence as ConsequenceLevel,
    decision: row.decision as ApprovalMode,
    status: row.status as AuthorityStatus,
    stepUpProvided: row.step_up_provided === 1,
    grantId: row.grant_id,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
  };
}

/** SQL-backed store using Node.js built-in `node:sqlite` (no native addon). */
export class SqliteAuthorityStore implements AuthorityStore {
  async reserveUse(id: string, version: number, now: Date, maxUsage: number | null, oneTime: boolean): Promise<boolean> {
    const result = this.db.prepare(`UPDATE authority_grants SET usage_count = usage_count + 1,
      status = CASE WHEN ? THEN 'CONSUMED' ELSE status END
      WHERE id = ? AND grant_version = ? AND status = 'ACTIVE'
      AND valid_from <= ? AND valid_until > ? AND (? IS NULL OR usage_count < ?)`)
      .run(oneTime ? 1 : 0, id, version, now.toISOString(), now.toISOString(), maxUsage, maxUsage);
    return Number(result.changes) === 1;
  }
  private db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(AUTHORITY_SQL_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async createGrant(input: CreateGrantInput): Promise<AuthorityGrant> {
    const now = new Date();
    const status = input.status ?? "ACTIVE";
    this.db
      .prepare(
        `INSERT INTO authority_grants (
          id, owner_id, actor_type, actor_id, audience, actions_json, resources_json,
          limits_json, conditions_json, approval_mode, consequence, one_time,
          valid_from, valid_until, status, policy_version, grant_version, parent_grant_id,
          usage_count, created_at, revoked_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          0, ?, NULL
        )`
      )
      .run(
        input.id,
        input.ownerId,
        input.actorType,
        input.actorId,
        input.audience,
        JSON.stringify(input.actions),
        JSON.stringify(input.resources),
        JSON.stringify(input.limits ?? {}),
        JSON.stringify(input.conditions ?? {}),
        input.approvalMode,
        input.consequence ?? "MEDIUM",
        input.oneTime ? 1 : 0,
        input.validFrom.toISOString(),
        input.validUntil.toISOString(),
        status,
        input.policyVersion ?? 1,
        input.grantVersion ?? 1,
        input.parentGrantId ?? null,
        now.toISOString()
      );
    const g = await this.getGrant(input.id);
    if (!g) throw new Error("grant insert failed");
    return g;
  }

  async getGrant(id: string): Promise<AuthorityGrant | null> {
    const row = this.db
      .prepare(`SELECT * FROM authority_grants WHERE id = ?`)
      .get(id) as GrantRow | undefined;
    return row ? mapGrant(row) : null;
  }

  async listGrants(ownerId: string, status?: AuthorityStatus): Promise<AuthorityGrant[]> {
    const rows = status
      ? (this.db
          .prepare(
            `SELECT * FROM authority_grants WHERE owner_id = ? AND status = ? ORDER BY created_at DESC`
          )
          .all(ownerId, status) as GrantRow[])
      : (this.db
          .prepare(
            `SELECT * FROM authority_grants WHERE owner_id = ? ORDER BY created_at DESC`
          )
          .all(ownerId) as GrantRow[]);
    return rows.map(mapGrant);
  }

  async updateGrantStatus(
    id: string,
    status: AuthorityStatus,
    revokedAt?: Date | null
  ): Promise<AuthorityGrant | null> {
    this.db
      .prepare(
        `UPDATE authority_grants SET status = ?, revoked_at = COALESCE(?, revoked_at) WHERE id = ?`
      )
      .run(status, revokedAt ? revokedAt.toISOString() : null, id);
    return this.getGrant(id);
  }

  async bumpGrantUsage(id: string): Promise<number> {
    this.db
      .prepare(`UPDATE authority_grants SET usage_count = usage_count + 1 WHERE id = ?`)
      .run(id);
    const g = await this.getGrant(id);
    return g?.usageCount ?? 0;
  }

  async createRequest(input: CreateRequestInput): Promise<AuthorityRequest> {
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO authority_requests (
          id, owner_id, actor_type, actor_id, audience, action, resource,
          consequence, decision, status, step_up_provided, grant_id, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        input.id,
        input.ownerId,
        input.actorType,
        input.actorId,
        input.audience,
        input.action,
        input.resource,
        input.consequence,
        input.decision,
        input.status,
        input.stepUpProvided ? 1 : 0,
        input.grantId ?? null,
        now.toISOString()
      );
    const r = await this.getRequest(input.id);
    if (!r) throw new Error("request insert failed");
    return r;
  }

  async getRequest(id: string): Promise<AuthorityRequest | null> {
    const row = this.db
      .prepare(`SELECT * FROM authority_requests WHERE id = ?`)
      .get(id) as RequestRow | undefined;
    return row ? mapRequest(row) : null;
  }

  async listPendingRequests(ownerId: string): Promise<AuthorityRequest[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM authority_requests WHERE owner_id = ? AND status = 'PENDING' ORDER BY created_at ASC`
      )
      .all(ownerId) as RequestRow[];
    return rows.map(mapRequest);
  }

  async resolveRequest(
    id: string,
    status: AuthorityStatus,
    grantId: string | null
  ): Promise<AuthorityRequest | null> {
    this.db
      .prepare(
        `UPDATE authority_requests SET status = ?, grant_id = ?, resolved_at = ? WHERE id = ?`
      )
      .run(status, grantId, new Date().toISOString(), id);
    return this.getRequest(id);
  }

  async tryConsumeJti(jti: string, grantId: string, actorKey: string): Promise<boolean> {
    try {
      this.db
        .prepare(
          `INSERT INTO authority_consumptions (jti, grant_id, actor_key, consumed_at) VALUES (?, ?, ?, ?)`
        )
        .run(jti, grantId, actorKey, new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  async isJtiConsumed(jti: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM authority_consumptions WHERE jti = ?`)
      .get(jti) as { ok: number } | undefined;
    return Boolean(row);
  }

  async appendAudit(
    event: Omit<AuditEvent, "createdAt"> & { createdAt?: Date }
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO authority_audit (
          id, type, owner_id, actor_type, actor_id, grant_id, request_id, jti, detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.type,
        event.ownerId,
        event.actorType,
        event.actorId,
        event.grantId,
        event.requestId,
        event.jti,
        JSON.stringify(event.detail),
        (event.createdAt ?? new Date()).toISOString()
      );
  }

  async listAudit(ownerId: string, limit = 100): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM authority_audit WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(ownerId, limit) as Array<{
      id: string;
      type: string;
      owner_id: string | null;
      actor_type: string | null;
      actor_id: string | null;
      grant_id: string | null;
      request_id: string | null;
      jti: string | null;
      detail_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      ownerId: r.owner_id,
      actorType: r.actor_type as ActorType | null,
      actorId: r.actor_id,
      grantId: r.grant_id,
      requestId: r.request_id,
      jti: r.jti,
      detail: JSON.parse(r.detail_json) as Record<string, unknown>,
      createdAt: new Date(r.created_at),
    }));
  }
}
