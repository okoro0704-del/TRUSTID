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

export type AuditEvent = {
  id: string;
  type: string;
  ownerId: string | null;
  actorType: ActorType | null;
  actorId: string | null;
  grantId: string | null;
  requestId: string | null;
  jti: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
};

export type CreateGrantInput = {
  id: string;
  ownerId: string;
  actorType: ActorType;
  actorId: string;
  audience: string;
  actions: string[];
  resources: string[];
  limits?: AuthorityLimits;
  conditions?: AuthorityConditions;
  approvalMode: ApprovalMode;
  consequence?: ConsequenceLevel;
  oneTime?: boolean;
  validFrom: Date;
  validUntil: Date;
  status?: AuthorityStatus;
  policyVersion?: number;
  grantVersion?: number;
  parentGrantId?: string | null;
};

export type CreateRequestInput = {
  id: string;
  ownerId: string;
  actorType: ActorType;
  actorId: string;
  audience: string;
  action: string;
  resource: string;
  consequence: ConsequenceLevel;
  decision: ApprovalMode;
  status: AuthorityStatus;
  stepUpProvided: boolean;
  grantId?: string | null;
};

export interface AuthorityStore {
  createGrant(input: CreateGrantInput): Promise<AuthorityGrant>;
  getGrant(id: string): Promise<AuthorityGrant | null>;
  listGrants(ownerId: string, status?: AuthorityStatus): Promise<AuthorityGrant[]>;
  updateGrantStatus(
    id: string,
    status: AuthorityStatus,
    revokedAt?: Date | null
  ): Promise<AuthorityGrant | null>;
  bumpGrantUsage(id: string): Promise<number>;
  /** Atomic live-state/version/usage check and reservation, before execution. */
  reserveUse(id: string, version: number, now: Date, maxUsage: number | null, oneTime: boolean): Promise<boolean>;
  createRequest(input: CreateRequestInput): Promise<AuthorityRequest>;
  getRequest(id: string): Promise<AuthorityRequest | null>;
  listPendingRequests(ownerId: string): Promise<AuthorityRequest[]>;
  resolveRequest(
    id: string,
    status: AuthorityStatus,
    grantId: string | null
  ): Promise<AuthorityRequest | null>;
  /** Returns true if first consumer; false on replay. Atomic. */
  tryConsumeJti(jti: string, grantId: string, actorKey: string): Promise<boolean>;
  isJtiConsumed(jti: string): Promise<boolean>;
  appendAudit(event: Omit<AuditEvent, "createdAt"> & { createdAt?: Date }): Promise<void>;
  listAudit(ownerId: string, limit?: number): Promise<AuditEvent[]>;
}

function toGrant(row: CreateGrantInput & { usageCount?: number; createdAt?: Date; revokedAt?: Date | null; status: AuthorityStatus }): AuthorityGrant {
  return {
    id: row.id,
    ownerId: row.ownerId,
    actorType: row.actorType,
    actorId: row.actorId,
    audience: row.audience,
    actions: [...row.actions],
    resources: [...row.resources],
    limits: { ...(row.limits ?? {}) },
    conditions: { ...(row.conditions ?? {}) },
    approvalMode: row.approvalMode,
    consequence: row.consequence ?? "MEDIUM",
    oneTime: row.oneTime ?? false,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    status: row.status,
    policyVersion: row.policyVersion ?? 1,
    grantVersion: row.grantVersion ?? 1,
    parentGrantId: row.parentGrantId ?? null,
    usageCount: row.usageCount ?? 0,
    createdAt: row.createdAt ?? new Date(),
    revokedAt: row.revokedAt ?? null,
  };
}

export class MemoryAuthorityStore implements AuthorityStore {
  private grants = new Map<string, AuthorityGrant>();
  private requests = new Map<string, AuthorityRequest>();
  private consumed = new Set<string>();
  private audit: AuditEvent[] = [];

  async reserveUse(id: string, version: number, now: Date, maxUsage: number | null, oneTime: boolean): Promise<boolean> {
    const g = this.grants.get(id);
    if (!g || g.status !== "ACTIVE" || g.grantVersion !== version ||
      now < g.validFrom || now >= g.validUntil || (maxUsage !== null && g.usageCount >= maxUsage)) return false;
    g.usageCount++;
    if (oneTime) g.status = "CONSUMED";
    return true;
  }

  async createGrant(input: CreateGrantInput): Promise<AuthorityGrant> {
    const g = toGrant({
      ...input,
      status: input.status ?? "ACTIVE",
    });
    this.grants.set(g.id, g);
    return { ...g, actions: [...g.actions], resources: [...g.resources], limits: { ...g.limits }, conditions: { ...g.conditions } };
  }

  async getGrant(id: string): Promise<AuthorityGrant | null> {
    const g = this.grants.get(id);
    return g
      ? {
          ...g,
          actions: [...g.actions],
          resources: [...g.resources],
          limits: { ...g.limits },
          conditions: { ...g.conditions },
        }
      : null;
  }

  async listGrants(ownerId: string, status?: AuthorityStatus): Promise<AuthorityGrant[]> {
    return [...this.grants.values()]
      .filter((g) => g.ownerId === ownerId && (status ? g.status === status : true))
      .map((g) => ({
        ...g,
        actions: [...g.actions],
        resources: [...g.resources],
        limits: { ...g.limits },
        conditions: { ...g.conditions },
      }));
  }

  async updateGrantStatus(
    id: string,
    status: AuthorityStatus,
    revokedAt?: Date | null
  ): Promise<AuthorityGrant | null> {
    const g = this.grants.get(id);
    if (!g) return null;
    g.status = status;
    if (revokedAt !== undefined) g.revokedAt = revokedAt;
    return this.getGrant(id);
  }

  async bumpGrantUsage(id: string): Promise<number> {
    const g = this.grants.get(id);
    if (!g) return 0;
    g.usageCount += 1;
    return g.usageCount;
  }

  async createRequest(input: CreateRequestInput): Promise<AuthorityRequest> {
    const r: AuthorityRequest = {
      id: input.id,
      ownerId: input.ownerId,
      actorType: input.actorType,
      actorId: input.actorId,
      audience: input.audience,
      action: input.action,
      resource: input.resource,
      consequence: input.consequence,
      decision: input.decision,
      status: input.status,
      stepUpProvided: input.stepUpProvided,
      grantId: input.grantId ?? null,
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.requests.set(r.id, r);
    return { ...r };
  }

  async getRequest(id: string): Promise<AuthorityRequest | null> {
    const r = this.requests.get(id);
    return r ? { ...r } : null;
  }

  async listPendingRequests(ownerId: string): Promise<AuthorityRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.ownerId === ownerId && r.status === "PENDING")
      .map((r) => ({ ...r }));
  }

  async resolveRequest(
    id: string,
    status: AuthorityStatus,
    grantId: string | null
  ): Promise<AuthorityRequest | null> {
    const r = this.requests.get(id);
    if (!r) return null;
    r.status = status;
    r.grantId = grantId;
    r.resolvedAt = new Date();
    return { ...r };
  }

  async tryConsumeJti(jti: string, _grantId: string, _actorKey: string): Promise<boolean> {
    if (this.consumed.has(jti)) return false;
    this.consumed.add(jti);
    return true;
  }

  async isJtiConsumed(jti: string): Promise<boolean> {
    return this.consumed.has(jti);
  }

  async appendAudit(
    event: Omit<AuditEvent, "createdAt"> & { createdAt?: Date }
  ): Promise<void> {
    this.audit.push({
      ...event,
      createdAt: event.createdAt ?? new Date(),
    });
  }

  async listAudit(ownerId: string, limit = 100): Promise<AuditEvent[]> {
    return this.audit
      .filter((e) => e.ownerId === ownerId)
      .slice(-limit)
      .map((e) => ({ ...e, detail: { ...e.detail } }));
  }
}
