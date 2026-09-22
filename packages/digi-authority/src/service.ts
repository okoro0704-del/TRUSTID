import { randomUUID } from "node:crypto";
import {
  evaluateActorPolicy,
  assertDelegationSubset,
  limitExceeded,
  consequenceForAction,
  type ActorPolicy,
} from "./policy.js";
import type { AuthorityStore } from "./stores.js";
import {
  mintAuthorityToken,
  verifyAuthorityToken,
  type AuthoritySigningKey,
  type VerifyAuthorityTokenResult,
} from "./tokens.js";
import {
  APPROVAL_MODES,
  AUTHORITY_STATUS,
  DIGI_AUTHORITY_ISSUER,
  DIGI_AUTHORITY_TOKEN_TTL_SECONDS,
  actorKey,
  parseActorKey,
  type ActorRef,
  type ApprovalMode,
  type AuthorityGrant,
  type AuthorityLimits,
  type AuthorityRequest,
  type CheckInput,
  type CheckResult,
} from "./types.js";

export type AuthorityServiceOptions = {
  store: AuthorityStore;
  signingKey: AuthoritySigningKey;
  policies?: ActorPolicy[];
  now?: () => Date;
  tokenTtlSeconds?: number;
};

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export class AuthorityService {
  private store: AuthorityStore;
  private signingKey: AuthoritySigningKey;
  private policies: ActorPolicy[];
  private nowFn: () => Date;
  private tokenTtlSeconds: number;

  constructor(opts: AuthorityServiceOptions) {
    this.store = opts.store;
    this.signingKey = opts.signingKey;
    this.policies = opts.policies ?? [];
    this.nowFn = opts.now ?? (() => new Date());
    this.tokenTtlSeconds = opts.tokenTtlSeconds ?? DIGI_AUTHORITY_TOKEN_TTL_SECONDS;
  }

  getHealth(): {
    status: "READY";
    issuer: string;
    tokenAlg: "EdDSA";
    kid: string;
  } {
    return {
      status: "READY",
      issuer: DIGI_AUTHORITY_ISSUER,
      tokenAlg: "EdDSA",
      kid: this.signingKey.kid,
    };
  }

  getPublicJwks() {
    return { keys: [this.signingKey.publicJwk] };
  }

  private findPolicy(actor: ActorRef, audience: string): ActorPolicy | null {
    return (
      this.policies.find(
        (p) =>
          p.actorType === actor.type &&
          p.actorId === actor.id &&
          (p.audience === "*" || p.audience === audience)
      ) ?? null
    );
  }

  private grantIsLive(grant: AuthorityGrant, now: Date): boolean {
    if (grant.status !== AUTHORITY_STATUS.ACTIVE) return false;
    if (now.getTime() < grant.validFrom.getTime()) return false;
    if (now.getTime() > grant.validUntil.getTime()) return false;
    return true;
  }

  private async audit(
    type: string,
    fields: {
      ownerId?: string | null;
      actorType?: ActorRef["type"] | null;
      actorId?: string | null;
      grantId?: string | null;
      requestId?: string | null;
      jti?: string | null;
      detail?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.store.appendAudit({
      id: newId("aud"),
      type,
      ownerId: fields.ownerId ?? null,
      actorType: fields.actorType ?? null,
      actorId: fields.actorId ?? null,
      grantId: fields.grantId ?? null,
      requestId: fields.requestId ?? null,
      jti: fields.jti ?? null,
      detail: fields.detail ?? {},
    });
  }

  /** Machine check: evaluate policy + existing grants. */
  async check(input: CheckInput): Promise<CheckResult> {
    const now = this.nowFn();
    await this.audit("authority.requested", {
      ownerId: input.ownerId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      detail: {
        action: input.action,
        resource: input.resource,
        audience: input.audience,
      },
    });

    const policy = this.findPolicy(input.actor, input.audience);
    const match = policy
      ? evaluateActorPolicy(policy, {
          actor: input.actor,
          action: input.action,
          audience: input.audience,
          resource: input.resource,
        })
      : {
          decision: APPROVAL_MODES.DENY as ApprovalMode,
          limits: {} as AuthorityLimits,
          consequence: consequenceForAction(input.action),
          requireStepUp: false,
          oneTime: false,
        };

    if (match.requireStepUp && !input.stepUpProvided) {
      await this.audit("authority.denied", {
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        detail: { reason: "step_up_required", action: input.action },
      });
      return { decision: "DENY", reason: "step_up_required" };
    }

    if (match.decision === APPROVAL_MODES.DENY) {
      await this.audit("authority.denied", {
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        detail: { action: input.action, resource: input.resource },
      });
      return { decision: "DENY", reason: "policy_deny" };
    }

    if (match.decision === APPROVAL_MODES.ASK_OWNER) {
      const req = await this.store.createRequest({
        id: newId("req"),
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        audience: input.audience,
        action: input.action,
        resource: input.resource,
        consequence: match.consequence,
        decision: APPROVAL_MODES.ASK_OWNER,
        status: AUTHORITY_STATUS.PENDING,
        stepUpProvided: Boolean(input.stepUpProvided),
      });
      await this.audit("authority.owner_approval_requested", {
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        requestId: req.id,
        detail: { action: input.action, resource: input.resource },
      });
      return { decision: "ASK_OWNER", requestId: req.id };
    }

    // ALLOW or ALLOW_WITH_LIMITS — find or create grant
    const existing = (await this.store.listGrants(input.ownerId, "ACTIVE")).find(
      (g) =>
        g.actorType === input.actor.type &&
        g.actorId === input.actor.id &&
        g.audience === input.audience &&
        g.actions.includes(input.action) &&
        g.resources.includes(input.resource) &&
        this.grantIsLive(g, now)
    );

    let grant = existing;
    if (!grant) {
      const validUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      grant = await this.store.createGrant({
        id: newId("auth"),
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        audience: input.audience,
        actions: [input.action],
        resources: [input.resource],
        limits: match.limits,
        conditions: match.requireStepUp ? { requireStepUp: true } : {},
        approvalMode: match.decision,
        consequence: match.consequence,
        oneTime: match.oneTime,
        validFrom: now,
        validUntil,
        status: AUTHORITY_STATUS.ACTIVE,
      });
    }

    const exceeded = limitExceeded(grant.limits, grant.usageCount);
    if (exceeded) {
      await this.audit("authority.denied", {
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        grantId: grant.id,
        detail: { reason: exceeded },
      });
      return { decision: "DENY", reason: exceeded };
    }

    if (match.decision === APPROVAL_MODES.ALLOW_WITH_LIMITS) {
      await this.audit("authority.allowed", {
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        grantId: grant.id,
        detail: { mode: "ALLOW_WITH_LIMITS", limits: grant.limits },
      });
      return {
        decision: "ALLOW_WITH_LIMITS",
        grantId: grant.id,
        limits: grant.limits,
      };
    }

    await this.audit("authority.allowed", {
      ownerId: input.ownerId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      grantId: grant.id,
      detail: { mode: "ALLOW" },
    });
    return { decision: "ALLOW", grantId: grant.id };
  }

  async listPending(ownerId: string): Promise<AuthorityRequest[]> {
    return this.store.listPendingRequests(ownerId);
  }

  async listActive(ownerId: string): Promise<AuthorityGrant[]> {
    return this.store.listGrants(ownerId, "ACTIVE");
  }

  async listRevoked(ownerId: string): Promise<AuthorityGrant[]> {
    return this.store.listGrants(ownerId, "REVOKED");
  }

  async inspect(grantId: string): Promise<AuthorityGrant | null> {
    return this.store.getGrant(grantId);
  }

  async approveRequest(
    ownerId: string,
    requestId: string,
    opts?: { oneTime?: boolean; ttlMs?: number }
  ): Promise<
    | { ok: true; grant: AuthorityGrant; token: string }
    | { ok: false; reason: string }
  > {
    const req = await this.store.getRequest(requestId);
    if (!req || req.ownerId !== ownerId) {
      return { ok: false, reason: "not_found" };
    }
    if (req.status !== AUTHORITY_STATUS.PENDING) {
      return { ok: false, reason: "not_pending" };
    }
    if (
      req.consequence === "CRITICAL" &&
      req.decision === APPROVAL_MODES.ASK_OWNER &&
      !req.stepUpProvided &&
      req.action === "payment.approve"
    ) {
      // Owner approval of payment still requires step-up on the original request.
      // If missing, deny.
      await this.store.resolveRequest(requestId, AUTHORITY_STATUS.DENIED, null);
      await this.audit("authority.denied", {
        ownerId,
        requestId,
        detail: { reason: "step_up_required_on_approve" },
      });
      return { ok: false, reason: "step_up_required" };
    }

    const now = this.nowFn();
    const oneTime = opts?.oneTime ?? true;
    const ttlMs = opts?.ttlMs ?? 60 * 60 * 1000;
    const grant = await this.store.createGrant({
      id: newId("auth"),
      ownerId,
      actorType: req.actorType,
      actorId: req.actorId,
      audience: req.audience,
      actions: [req.action],
      resources: [req.resource],
      limits: {},
      conditions: {},
      approvalMode: APPROVAL_MODES.ALLOW,
      consequence: req.consequence,
      oneTime,
      validFrom: now,
      validUntil: new Date(now.getTime() + ttlMs),
      status: AUTHORITY_STATUS.ACTIVE,
    });
    await this.store.resolveRequest(requestId, AUTHORITY_STATUS.ACTIVE, grant.id);
    await this.audit("authority.approved", {
      ownerId,
      actorType: req.actorType,
      actorId: req.actorId,
      grantId: grant.id,
      requestId,
    });

    const minted = await this.issueTokenFromGrant(grant, {
      actions: [req.action],
      resources: [req.resource],
    });
    return { ok: true, grant, token: minted.token };
  }

  async denyRequest(
    ownerId: string,
    requestId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const req = await this.store.getRequest(requestId);
    if (!req || req.ownerId !== ownerId) {
      return { ok: false, reason: "not_found" };
    }
    if (req.status !== AUTHORITY_STATUS.PENDING) {
      return { ok: false, reason: "not_pending" };
    }
    await this.store.resolveRequest(requestId, AUTHORITY_STATUS.DENIED, null);
    await this.audit("authority.denied", {
      ownerId,
      requestId,
      actorType: req.actorType,
      actorId: req.actorId,
      detail: { by: "owner" },
    });
    return { ok: true };
  }

  async revoke(
    ownerId: string,
    grantId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const grant = await this.store.getGrant(grantId);
    if (!grant || grant.ownerId !== ownerId) {
      return { ok: false, reason: "not_found" };
    }
    if (grant.status === AUTHORITY_STATUS.REVOKED) {
      return { ok: true };
    }
    await this.store.updateGrantStatus(
      grantId,
      AUTHORITY_STATUS.REVOKED,
      this.nowFn()
    );
    await this.audit("authority.revoked", {
      ownerId,
      grantId,
      actorType: grant.actorType,
      actorId: grant.actorId,
    });
    return { ok: true };
  }

  async issueToken(
    ownerId: string,
    grantId: string,
    narrow?: { actions?: string[]; resources?: string[]; ttlSeconds?: number }
  ): Promise<
    | { ok: true; token: string; jti: string; exp: number }
    | { ok: false; reason: string }
  > {
    const grant = await this.store.getGrant(grantId);
    if (!grant || grant.ownerId !== ownerId) {
      return { ok: false, reason: "not_found" };
    }
    const now = this.nowFn();
    if (!this.grantIsLive(grant, now)) {
      if (grant.status === AUTHORITY_STATUS.REVOKED) {
        return { ok: false, reason: "revoked" };
      }
      return { ok: false, reason: "grant_not_active" };
    }
    const actions = narrow?.actions ?? grant.actions;
    const resources = narrow?.resources ?? grant.resources;
    for (const a of actions) {
      if (!grant.actions.includes(a)) {
        return { ok: false, reason: "action_not_in_grant" };
      }
    }
    for (const r of resources) {
      if (!grant.resources.includes(r)) {
        return { ok: false, reason: "resource_not_in_grant" };
      }
    }
    const exceeded = limitExceeded(grant.limits, grant.usageCount);
    if (exceeded) {
      return { ok: false, reason: exceeded };
    }
    const minted = await this.issueTokenFromGrant(grant, {
      actions,
      resources,
      ttlSeconds: narrow?.ttlSeconds,
    });
    return {
      ok: true,
      token: minted.token,
      jti: minted.claims.jti,
      exp: minted.claims.exp,
    };
  }

  private async issueTokenFromGrant(
    grant: AuthorityGrant,
    narrow: { actions: string[]; resources: string[]; ttlSeconds?: number }
  ) {
    const jti = newId("jti");
    const minted = await mintAuthorityToken(this.signingKey, {
      ownerId: grant.ownerId,
      audience: grant.audience,
      actor: actorKey({ type: grant.actorType, id: grant.actorId }),
      actions: narrow.actions,
      resources: narrow.resources,
      limits: grant.limits,
      approval: grant.approvalMode,
      grantId: grant.id,
      grantVersion: grant.grantVersion,
      oneTime: grant.oneTime,
      jti,
      ttlSeconds: narrow.ttlSeconds ?? this.tokenTtlSeconds,
      now: this.nowFn(),
    });
    await this.audit("authority.token_issued", {
      ownerId: grant.ownerId,
      actorType: grant.actorType,
      actorId: grant.actorId,
      grantId: grant.id,
      jti,
      detail: {
        actions: narrow.actions,
        resources: narrow.resources,
        aud: grant.audience,
      },
    });
    return minted;
  }

  /**
   * Consumer verifies token cryptographically, then optionally consumes one-time jti.
   * Fail-closed.
   */
  async useToken(input: {
    token: string;
    expectedAudience: string;
    expectedActor: string;
    expectedAction: string;
    expectedResource: string;
  }): Promise<
    | { ok: true; grantId: string; jti: string }
    | { ok: false; reason: string }
  > {
    const verified = await verifyAuthorityToken({
      token: input.token,
      expectedAudience: input.expectedAudience,
      expectedActor: input.expectedActor,
      expectedAction: input.expectedAction,
      expectedResource: input.expectedResource,
      publicJwks: [this.signingKey.publicJwk],
      now: this.nowFn(),
    });
    if (!verified.ok) {
      await this.audit("authority.denied", {
        detail: { reason: verified.reason, phase: "verify" },
      });
      return { ok: false, reason: verified.reason };
    }

    const grant = await this.store.getGrant(verified.claims.grantId);
    if (!grant || grant.status === AUTHORITY_STATUS.REVOKED) {
      await this.audit("authority.denied", {
        grantId: verified.claims.grantId,
        jti: verified.claims.jti,
        detail: { reason: "revoked_or_missing" },
      });
      return { ok: false, reason: "revoked" };
    }
    if (grant.grantVersion !== verified.claims.grantVersion) {
      return { ok: false, reason: "grant_version_mismatch" };
    }

    const exceeded = limitExceeded(grant.limits, grant.usageCount);
    if (exceeded) {
      await this.audit("authority.denied", {
        grantId: grant.id,
        jti: verified.claims.jti,
        detail: { reason: exceeded },
      });
      return { ok: false, reason: exceeded };
    }

    if (verified.claims.oneTime || grant.oneTime) {
      const first = await this.store.tryConsumeJti(
        verified.claims.jti,
        grant.id,
        verified.claims.actor
      );
      if (!first) {
        await this.audit("authority.replay_rejected", {
          ownerId: grant.ownerId,
          grantId: grant.id,
          jti: verified.claims.jti,
          actorType: grant.actorType,
          actorId: grant.actorId,
        });
        return { ok: false, reason: "replay" };
      }
      await this.store.updateGrantStatus(grant.id, AUTHORITY_STATUS.CONSUMED);
    }

    await this.store.bumpGrantUsage(grant.id);
    await this.audit("authority.used", {
      ownerId: grant.ownerId,
      actorType: grant.actorType,
      actorId: grant.actorId,
      grantId: grant.id,
      jti: verified.claims.jti,
      detail: {
        action: input.expectedAction,
        resource: input.expectedResource,
        audience: input.expectedAudience,
      },
    });

    return {
      ok: true,
      grantId: grant.id,
      jti: verified.claims.jti,
    };
  }

  async delegate(input: {
    ownerId: string;
    parentGrantId: string;
    actor: ActorRef;
    actions: string[];
    resources: string[];
    validUntil: Date;
    limits?: AuthorityLimits;
  }): Promise<
    | { ok: true; grant: AuthorityGrant }
    | { ok: false; reason: string }
  > {
    const parent = await this.store.getGrant(input.parentGrantId);
    if (!parent || parent.ownerId !== input.ownerId) {
      return { ok: false, reason: "parent_not_found" };
    }
    if (parent.status !== AUTHORITY_STATUS.ACTIVE) {
      return { ok: false, reason: "parent_not_active" };
    }
    // Actor cannot self-escalate by creating a parent they don't own — already checked.
    // Delegation from twin to agent: parent must allow authority.delegate? Spec says
    // twin is DENY for authority.delegate — so only owner-initiated delegate via this API.
    const check = assertDelegationSubset(parent, {
      actions: input.actions,
      resources: input.resources,
      validUntil: input.validUntil,
      limits: input.limits ?? {},
      audience: parent.audience,
      ownerId: input.ownerId,
    });
    if (!check.ok) {
      await this.audit("authority.denied", {
        ownerId: input.ownerId,
        grantId: parent.id,
        detail: { reason: check.reason, phase: "delegate" },
      });
      return { ok: false, reason: check.reason };
    }
    const now = this.nowFn();
    const grant = await this.store.createGrant({
      id: newId("auth"),
      ownerId: input.ownerId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      audience: parent.audience,
      actions: input.actions,
      resources: input.resources,
      limits: input.limits ?? {},
      conditions: {},
      approvalMode: APPROVAL_MODES.ALLOW,
      consequence: parent.consequence,
      oneTime: false,
      validFrom: now,
      validUntil: input.validUntil,
      status: AUTHORITY_STATUS.ACTIVE,
      parentGrantId: parent.id,
      policyVersion: parent.policyVersion,
      grantVersion: 1,
    });
    return { ok: true, grant };
  }

  verifyTokenLocally(input: {
    token: string;
    expectedAudience: string;
    expectedActor?: string;
    expectedAction?: string;
    expectedResource?: string;
  }): Promise<VerifyAuthorityTokenResult> {
    return verifyAuthorityToken({
      ...input,
      publicJwks: [this.signingKey.publicJwk],
      now: this.nowFn(),
    });
  }
}

export { parseActorKey, actorKey };
