/** Phase T3 — consequential authority model (Digi-owned). */

export const ACTOR_TYPES = {
  HUMAN: "human",
  APP: "app",
  SERVICE: "service",
  DIGITAL_TWIN: "digital_twin",
  DEVICE: "device",
  BUSINESS: "business",
} as const;

export type ActorType = (typeof ACTOR_TYPES)[keyof typeof ACTOR_TYPES];

export type ActorRef = {
  type: ActorType;
  id: string;
};

export function actorKey(actor: ActorRef): string {
  return `${actor.type}:${actor.id}`;
}

export function parseActorKey(raw: string): ActorRef | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const type = raw.slice(0, i) as ActorType;
  const id = raw.slice(i + 1).trim();
  if (!id || !(Object.values(ACTOR_TYPES) as string[]).includes(type)) {
    return null;
  }
  return { type, id };
}

export const APPROVAL_MODES = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  ASK_OWNER: "ASK_OWNER",
  ALLOW_WITH_LIMITS: "ALLOW_WITH_LIMITS",
} as const;

export type ApprovalMode =
  (typeof APPROVAL_MODES)[keyof typeof APPROVAL_MODES];

export const AUTHORITY_STATUS = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  CONSUMED: "CONSUMED",
} as const;

export type AuthorityStatus =
  (typeof AUTHORITY_STATUS)[keyof typeof AUTHORITY_STATUS];

export const CONSEQUENCE_LEVELS = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;

export type ConsequenceLevel =
  (typeof CONSEQUENCE_LEVELS)[keyof typeof CONSEQUENCE_LEVELS];

/** Digi authority token issuer claim (not TrustID identity issuer). */
export const DIGI_AUTHORITY_ISSUER = "digiconomy-authority";

export const DIGI_AUTHORITY_TOKEN_TTL_SECONDS = 300;

export type AuthorityLimits = {
  maxAmount?: number;
  currency?: string;
  maxDailyAmount?: number;
  maxMessages?: number;
  maxPosts?: number;
  maxDeployments?: number;
  maxRecipients?: number;
  maxFileSize?: number;
  [key: string]: number | string | undefined;
};

export type AuthorityConditions = {
  requireStepUp?: boolean;
  requireTrustedDevice?: boolean;
  requireOwnerOnline?: boolean;
  businessHoursOnly?: boolean;
  assistedModeOnly?: boolean;
  boundDeviceId?: string;
  boundSessionId?: string;
};

export type AuthorityGrant = {
  id: string;
  ownerId: string;
  actorType: ActorType;
  actorId: string;
  audience: string;
  actions: string[];
  resources: string[];
  limits: AuthorityLimits;
  conditions: AuthorityConditions;
  approvalMode: ApprovalMode;
  consequence: ConsequenceLevel;
  oneTime: boolean;
  validFrom: Date;
  validUntil: Date;
  status: AuthorityStatus;
  policyVersion: number;
  grantVersion: number;
  parentGrantId: string | null;
  usageCount: number;
  createdAt: Date;
  revokedAt: Date | null;
};

export type AuthorityRequest = {
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
  grantId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export type AuthorityTokenClaims = {
  iss: typeof DIGI_AUTHORITY_ISSUER;
  sub: string; // Digi owner id
  aud: string;
  actor: string;
  actions: string[];
  resources: string[];
  limits: AuthorityLimits;
  approval: ApprovalMode;
  grantId: string;
  grantVersion: number;
  oneTime: boolean;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  /** Optional TrustID subject for service authorship (ElfCom). */
  ownerTrustId?: string;
};

export type CheckInput = {
  ownerId: string;
  actor: ActorRef;
  action: string;
  resource: string;
  audience: string;
  stepUpProvided?: boolean;
};

export type CheckResult =
  | { decision: "ALLOW"; grantId?: string }
  | { decision: "DENY"; reason: string }
  | { decision: "ASK_OWNER"; requestId: string }
  | { decision: "ALLOW_WITH_LIMITS"; grantId: string; limits: AuthorityLimits };
