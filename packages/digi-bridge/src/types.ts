/**
 * Digi owner resolution — issuer+subject ? unique DigiOwner (concurrency-safe).
 */
export type DigiOwner = {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExternalIdentity = {
  id: string;
  ownerId: string;
  issuer: string;
  subject: string;
  createdAt: Date;
  lastSeenAt: Date;
};

export type DigiSession = {
  id: string;
  ownerId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
};

export type OwnerStore = {
  resolveOrCreate(input: {
    issuer: string;
    subject: string;
  }): Promise<{ owner: DigiOwner; created: boolean; identity: ExternalIdentity }>;
  findByIssuerSubject(
    issuer: string,
    subject: string,
  ): Promise<ExternalIdentity | null>;
};

export type ReplayStore = {
  /** Atomically consume jti. Returns false if already consumed or conflict. */
  tryConsume(input: {
    jti: string;
    issuer: string;
    subject: string;
    expiresAt: Date;
  }): Promise<boolean>;
};

export type SessionStore = {
  create(input: {
    ownerId: string;
    ttlSeconds?: number;
  }): Promise<{ session: DigiSession; token: string }>;
  resolve(token: string): Promise<DigiSession | null>;
  revoke(sessionId: string): Promise<void>;
};

export type DigiAuditEvent =
  | "trust_assertion_accepted"
  | "trust_assertion_rejected"
  | "trust_assertion_replay_rejected"
  | "trust_assertion_wrong_issuer"
  | "trust_assertion_wrong_audience"
  | "trust_assertion_expired"
  | "trust_assertion_bad_signature"
  | "trust_assertion_unknown_kid"
  | "digi_owner_created"
  | "digi_owner_resolved"
  | "digi_session_created";

export type DigiAuditSink = {
  record(event: DigiAuditEvent, meta: Record<string, unknown>): Promise<void> | void;
};
