import pg from "pg";
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

const { Pool } = pg;

export const AUTHORITY_PG_SCHEMA = `
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
  one_time BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  grant_version INTEGER NOT NULL DEFAULT 1,
  parent_grant_id TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
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
  step_up_provided BOOLEAN NOT NULL DEFAULT FALSE,
  grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_requests_owner ON authority_requests(owner_id, status);

CREATE TABLE IF NOT EXISTS authority_consumptions (
  jti TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS authority_idempotency (
  key TEXT PRIMARY KEY,
  jti TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
  one_time: boolean;
  valid_from: Date;
  valid_until: Date;
  status: string;
  policy_version: number;
  grant_version: number;
  parent_grant_id: string | null;
  usage_count: number;
  created_at: Date;
  revoked_at: Date | null;
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
  step_up_provided: boolean;
  grant_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
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
    oneTime: Boolean(row.one_time),
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
    stepUpProvided: Boolean(row.step_up_provided),
    grantId: row.grant_id,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
  };
}

/** Production Digi authority store  Postgres, multi-instance safe via UNIQUE jti. */
export class PostgresAuthorityStore implements AuthorityStore {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.pool.query(AUTHORITY_PG_SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensure(): Promise<void> {
    await this.ready;
  }

  async createGrant(input: CreateGrantInput): Promise<AuthorityGrant> {
    await this.ensure();
    const status = input.status ?? "ACTIVE";
    await this.pool.query(
      `INSERT INTO authority_grants (
        id, owner_id, actor_type, actor_id, audience, actions_json, resources_json,
        limits_json, conditions_json, approval_mode, consequence, one_time,
        valid_from, valid_until, status, policy_version, grant_version, parent_grant_id,
        usage_count, created_at, revoked_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,NOW(),NULL
      )`,
      [
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
        Boolean(input.oneTime),
        input.validFrom.toISOString(),
        input.validUntil.toISOString(),
        status,
        input.policyVersion ?? 1,
        input.grantVersion ?? 1,
        input.parentGrantId ?? null,
      ]
    );
    const g = await this.getGrant(input.id);
    if (!g) throw new Error("grant insert failed");
    return g;
  }

  async getGrant(id: string): Promise<AuthorityGrant | null> {
    await this.ensure();
    const r = await this.pool.query<GrantRow>(
      `SELECT * FROM authority_grants WHERE id = $1`,
      [id]
    );
    return r.rows[0] ? mapGrant(r.rows[0]) : null;
  }

  async listGrants(ownerId: string, status?: AuthorityStatus): Promise<AuthorityGrant[]> {
    await this.ensure();
    const r = status
      ? await this.pool.query<GrantRow>(
          `SELECT * FROM authority_grants WHERE owner_id = $1 AND status = $2 ORDER BY created_at DESC`,
          [ownerId, status]
        )
      : await this.pool.query<GrantRow>(
          `SELECT * FROM authority_grants WHERE owner_id = $1 ORDER BY created_at DESC`,
          [ownerId]
        );
    return r.rows.map(mapGrant);
  }

  async updateGrantStatus(
    id: string,
    status: AuthorityStatus,
    revokedAt?: Date | null
  ): Promise<AuthorityGrant | null> {
    await this.ensure();
    await this.pool.query(
      `UPDATE authority_grants SET status = $1, revoked_at = COALESCE($2, revoked_at) WHERE id = $3`,
      [status, revokedAt ? revokedAt.toISOString() : null, id]
    );
    return this.getGrant(id);
  }

  async bumpGrantUsage(id: string): Promise<number> {
    await this.ensure();
    const r = await this.pool.query<{ usage_count: number }>(
      `UPDATE authority_grants SET usage_count = usage_count + 1 WHERE id = $1 RETURNING usage_count`,
      [id]
    );
    return r.rows[0]?.usage_count ?? 0;
  }

  async reserveUse(id: string, version: number, now: Date, maxUsage: number | null, oneTime: boolean): Promise<boolean> {
    await this.ensure();
    const result = await this.pool.query(
      `UPDATE authority_grants SET usage_count = usage_count + 1,
       status = CASE WHEN $5 THEN 'CONSUMED' ELSE status END
       WHERE id = $1 AND grant_version = $2 AND status = 'ACTIVE'
       AND valid_from <= $3 AND valid_until > $3
       AND ($4::integer IS NULL OR usage_count < $4) RETURNING id`,
      [id, version, now.toISOString(), maxUsage, oneTime]);
    return result.rowCount === 1;
  }

  async createRequest(input: CreateRequestInput): Promise<AuthorityRequest> {
    await this.ensure();
    await this.pool.query(
      `INSERT INTO authority_requests (
        id, owner_id, actor_type, actor_id, audience, action, resource,
        consequence, decision, status, step_up_provided, grant_id, created_at, resolved_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NULL)`,
      [
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
        Boolean(input.stepUpProvided),
        input.grantId ?? null,
      ]
    );
    const req = await this.getRequest(input.id);
    if (!req) throw new Error("request insert failed");
    return req;
  }

  async getRequest(id: string): Promise<AuthorityRequest | null> {
    await this.ensure();
    const r = await this.pool.query<RequestRow>(
      `SELECT * FROM authority_requests WHERE id = $1`,
      [id]
    );
    return r.rows[0] ? mapRequest(r.rows[0]) : null;
  }

  async listPendingRequests(ownerId: string): Promise<AuthorityRequest[]> {
    await this.ensure();
    const r = await this.pool.query<RequestRow>(
      `SELECT * FROM authority_requests WHERE owner_id = $1 AND status = 'PENDING' ORDER BY created_at ASC`,
      [ownerId]
    );
    return r.rows.map(mapRequest);
  }

  async resolveRequest(
    id: string,
    status: AuthorityStatus,
    grantId: string | null
  ): Promise<AuthorityRequest | null> {
    await this.ensure();
    await this.pool.query(
      `UPDATE authority_requests SET status = $1, grant_id = $2, resolved_at = NOW() WHERE id = $3`,
      [status, grantId, id]
    );
    return this.getRequest(id);
  }

  async tryConsumeJti(jti: string, grantId: string, actorKey: string): Promise<boolean> {
    await this.ensure();
    try {
      await this.pool.query(
        `INSERT INTO authority_consumptions (jti, grant_id, actor_key, consumed_at) VALUES ($1,$2,$3,NOW())`,
        [jti, grantId, actorKey]
      );
      return true;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "23505") return false; // unique_violation
      throw err;
    }
  }

  async isJtiConsumed(jti: string): Promise<boolean> {
    await this.ensure();
    const r = await this.pool.query(
      `SELECT 1 AS ok FROM authority_consumptions WHERE jti = $1`,
      [jti]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async appendAudit(
    event: Omit<AuditEvent, "createdAt"> & { createdAt?: Date }
  ): Promise<void> {
    await this.ensure();
    await this.pool.query(
      `INSERT INTO authority_audit (
        id, type, owner_id, actor_type, actor_id, grant_id, request_id, jti, detail_json, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()))`,
      [
        event.id,
        event.type,
        event.ownerId,
        event.actorType,
        event.actorId,
        event.grantId,
        event.requestId,
        event.jti,
        JSON.stringify(event.detail),
        event.createdAt?.toISOString() ?? null,
      ]
    );
  }

  async listAudit(ownerId: string, limit = 100): Promise<AuditEvent[]> {
    await this.ensure();
    const r = await this.pool.query<{
      id: string;
      type: string;
      owner_id: string | null;
      actor_type: string | null;
      actor_id: string | null;
      grant_id: string | null;
      request_id: string | null;
      jti: string | null;
      detail_json: string;
      created_at: Date;
    }>(
      `SELECT * FROM authority_audit WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ownerId, limit]
    );
    return r.rows.map((row) => ({
      id: row.id,
      type: row.type,
      ownerId: row.owner_id,
      actorType: row.actor_type as ActorType | null,
      actorId: row.actor_id,
      grantId: row.grant_id,
      requestId: row.request_id,
      jti: row.jti,
      detail: JSON.parse(row.detail_json) as Record<string, unknown>,
      createdAt: new Date(row.created_at),
    }));
  }
}
