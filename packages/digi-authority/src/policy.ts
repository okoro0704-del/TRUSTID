import {
  APPROVAL_MODES,
  CONSEQUENCE_LEVELS,
  type ActorRef,
  type ApprovalMode,
  type AuthorityLimits,
  type ConsequenceLevel,
} from "./types.js";

export type PolicyRule = {
  actions: string[];
  resources?: string[]; // if omitted, any resource under audience
  decision: ApprovalMode;
  limits?: AuthorityLimits;
  consequence?: ConsequenceLevel;
  requireStepUp?: boolean;
  oneTime?: boolean;
};

export type ActorPolicy = {
  actorType: ActorRef["type"];
  actorId: string;
  audience: string;
  rules: PolicyRule[];
  defaultDecision?: ApprovalMode;
};

/** Reference Digital Twin policy for Mr FundzMan (fixture, not global). */
export const DIGITAL_TWIN_MRFUNDZMAN_POLICY: ActorPolicy = {
  actorType: "digital_twin",
  actorId: "mrfundzman",
  audience: "*",
  defaultDecision: APPROVAL_MODES.DENY,
  rules: [
    {
      actions: ["tv.program.create", "radio.program.create"],
      decision: APPROVAL_MODES.ALLOW,
      consequence: CONSEQUENCE_LEVELS.MEDIUM,
    },
    {
      actions: ["tv.program.publish", "radio.program.publish"],
      decision: APPROVAL_MODES.ALLOW_WITH_LIMITS,
      limits: { maxPosts: 1 },
      consequence: CONSEQUENCE_LEVELS.HIGH,
    },
    {
      actions: ["tv.live.start", "radio.live.start"],
      decision: APPROVAL_MODES.ASK_OWNER,
      consequence: CONSEQUENCE_LEVELS.HIGH,
    },
    {
      actions: ["payment.approve"],
      decision: APPROVAL_MODES.ASK_OWNER,
      consequence: CONSEQUENCE_LEVELS.CRITICAL,
      requireStepUp: true,
      oneTime: true,
    },
    {
      actions: ["authority.delegate", "ownership.transfer", "security.change"],
      decision: APPROVAL_MODES.DENY,
      consequence: CONSEQUENCE_LEVELS.CRITICAL,
    },
  ],
};

export function consequenceForAction(action: string): ConsequenceLevel {
  if (
    action.startsWith("payment.") ||
    action === "ownership.transfer" ||
    action === "security.change" ||
    action === "device.revoke" ||
    action === "authority.delegate"
  ) {
    return CONSEQUENCE_LEVELS.CRITICAL;
  }
  if (action.includes(".publish") || action.includes(".live.")) {
    return CONSEQUENCE_LEVELS.HIGH;
  }
  if (action.includes(".send") || action.includes(".create") || action.includes(".write")) {
    return CONSEQUENCE_LEVELS.MEDIUM;
  }
  return CONSEQUENCE_LEVELS.LOW;
}

export type PolicyMatch = {
  decision: ApprovalMode;
  limits: AuthorityLimits;
  consequence: ConsequenceLevel;
  requireStepUp: boolean;
  oneTime: boolean;
};

export function evaluateActorPolicy(
  policy: ActorPolicy,
  input: { actor: ActorRef; action: string; audience: string; resource: string }
): PolicyMatch {
  if (
    policy.actorType !== input.actor.type ||
    policy.actorId !== input.actor.id
  ) {
    return {
      decision: APPROVAL_MODES.DENY,
      limits: {},
      consequence: consequenceForAction(input.action),
      requireStepUp: false,
      oneTime: false,
    };
  }
  if (policy.audience !== "*" && policy.audience !== input.audience) {
    return {
      decision: APPROVAL_MODES.DENY,
      limits: {},
      consequence: consequenceForAction(input.action),
      requireStepUp: false,
      oneTime: false,
    };
  }

  for (const rule of policy.rules) {
    if (!rule.actions.includes(input.action)) continue;
    if (rule.resources && !rule.resources.includes(input.resource)) continue;
    return {
      decision: rule.decision,
      limits: { ...(rule.limits ?? {}) },
      consequence: rule.consequence ?? consequenceForAction(input.action),
      requireStepUp: Boolean(rule.requireStepUp),
      oneTime: Boolean(rule.oneTime),
    };
  }

  return {
    decision: policy.defaultDecision ?? APPROVAL_MODES.DENY,
    limits: {},
    consequence: consequenceForAction(input.action),
    requireStepUp: false,
    oneTime: false,
  };
}

/** Child grant must never exceed parent. */
export function assertDelegationSubset(parent: {
  actions: string[];
  resources: string[];
  validUntil: Date;
  limits: AuthorityLimits;
  audience: string;
  ownerId: string;
}, child: {
  actions: string[];
  resources: string[];
  validUntil: Date;
  limits: AuthorityLimits;
  audience: string;
  ownerId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (child.ownerId !== parent.ownerId) {
    return { ok: false, reason: "owner_mismatch" };
  }
  if (child.audience !== parent.audience) {
    return { ok: false, reason: "audience_escalation" };
  }
  if (child.validUntil.getTime() > parent.validUntil.getTime()) {
    return { ok: false, reason: "expiry_escalation" };
  }
  for (const a of child.actions) {
    if (!parent.actions.includes(a)) {
      return { ok: false, reason: "action_escalation" };
    }
  }
  for (const r of child.resources) {
    if (!parent.resources.includes(r)) {
      return { ok: false, reason: "resource_escalation" };
    }
  }
  for (const [k, v] of Object.entries(child.limits)) {
    if (typeof v !== "number") continue;
    const p = parent.limits[k];
    if (typeof p === "number" && v > p) {
      return { ok: false, reason: "limit_escalation" };
    }
    if (p === undefined) {
      // child introducing a numeric limit key parent lacks is OK only if tightening;
      // introducing new higher capability via limits is not escalation of scope.
      // Treat unknown parent numeric as unlimited ? child may set any number.
      continue;
    }
  }
  return { ok: true };
}

export function limitExceeded(
  limits: AuthorityLimits,
  usageCount: number
): string | null {
  if (typeof limits.maxPosts === "number" && usageCount >= limits.maxPosts) {
    return "maxPosts_exceeded";
  }
  if (typeof limits.maxMessages === "number" && usageCount >= limits.maxMessages) {
    return "maxMessages_exceeded";
  }
  if (
    typeof limits.maxDeployments === "number" &&
    usageCount >= limits.maxDeployments
  ) {
    return "maxDeployments_exceeded";
  }
  return null;
}
