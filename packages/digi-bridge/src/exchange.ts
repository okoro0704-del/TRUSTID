import type { DigiVerifyFailureReason } from "./verify.js";
import { verifyDigiAssertion, type JwksCache } from "./verify.js";
import type {
  DigiAuditSink,
  OwnerStore,
  ReplayStore,
  SessionStore,
} from "./types.js";

export type ExchangeSuccess = {
  ok: true;
  ownerId: string;
  ownerCreated: boolean;
  sessionToken: string;
  sessionId: string;
  expiresAt: string;
  subject: string;
};

export type ExchangeFailure = {
  ok: false;
  error: "unauthorized";
  reason: DigiVerifyFailureReason | "replay";
};

function mapRejectEvent(
  reason: DigiVerifyFailureReason | "replay",
): Parameters<DigiAuditSink["record"]>[0] {
  switch (reason) {
    case "replay":
      return "trust_assertion_replay_rejected";
    case "issuer_mismatch":
      return "trust_assertion_wrong_issuer";
    case "audience_mismatch":
    case "missing_audience":
      return "trust_assertion_wrong_audience";
    case "expired":
      return "trust_assertion_expired";
    case "bad_signature":
    case "alg_none":
    case "unsupported_alg":
      return "trust_assertion_bad_signature";
    case "unknown_kid":
      return "trust_assertion_unknown_kid";
    default:
      return "trust_assertion_rejected";
  }
}

/**
 * Digi exchange: verify TrustID assertion, then consume jti, resolve owner, and create a Digi session.
 * Verification stays outside the database transaction. Durable writes commit together when runWrite is set.
 */
export async function exchangeTrustIdAssertion(input: {
  assertion: string;
  expectedIssuer: string;
  expectedAudience: string;
  jwks: JwksCache;
  owners: OwnerStore;
  replay: ReplayStore;
  sessions: SessionStore;
  audit?: DigiAuditSink;
  nowSec?: number;
  /**
   * Optional transaction boundary for the durable writes.
   * Verification has already finished and must not be included.
   * PostgreSQL composition passes one transaction so a later failure
   * rolls consumption back. Memory stores omit it.
   */
  runWrite?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<ExchangeSuccess | ExchangeFailure> {
  const verified = await verifyDigiAssertion({
    assertion: input.assertion,
    expectedIssuer: input.expectedIssuer,
    expectedAudience: input.expectedAudience,
    jwks: input.jwks,
    nowSec: input.nowSec,
  });

  if (!verified.ok) {
    await input.audit?.record(mapRejectEvent(verified.reason), {
      reason: verified.reason,
    });
    return { ok: false, error: "unauthorized", reason: verified.reason };
  }

  const runWrite = input.runWrite ?? (async <T>(fn: () => Promise<T>) => fn());
  let outcome:
    | { kind: "replay" }
    | {
        kind: "ok";
        ownerId: string;
        identityId: string;
        created: boolean;
        sessionId: string;
        token: string;
        expiresAt: string;
      };
  try {
    outcome = await runWrite(async () => {
      const consumed = await input.replay.tryConsume({
        jti: verified.jti,
        issuer: verified.issuer,
        subject: verified.subject,
        expiresAt: new Date(verified.exp * 1000),
      });
      if (!consumed) return { kind: "replay" as const };
      const { owner, created, identity } = await input.owners.resolveOrCreate({
        issuer: verified.issuer,
        subject: verified.subject,
      });
      const { session, token } = await input.sessions.create({
        ownerId: owner.id,
      });
      return {
        kind: "ok" as const,
        ownerId: owner.id,
        identityId: identity.id,
        created,
        sessionId: session.id,
        token,
        expiresAt: session.expiresAt.toISOString(),
      };
    });
  } catch {
    try {
      await input.audit?.record("digi_persistence_failed", {
        reason: "storage_failure",
      });
    } catch {
      /* audit must not replace the storage failure */
    }
    throw new Error("Digi Core persistence failed");
  }

  if (outcome.kind === "replay") {
    await input.audit?.record("trust_assertion_replay_rejected", {
      jti: verified.jti,
    });
    return { ok: false, error: "unauthorized", reason: "replay" };
  }

  try {
    await input.audit?.record("trust_assertion_accepted", {
      jti: verified.jti,
      issuer: verified.issuer,
      audience: verified.audience,
    });
    await input.audit?.record(
      outcome.created ? "digi_owner_created" : "digi_owner_resolved",
      {
        ownerId: outcome.ownerId,
        identityId: outcome.identityId,
        issuer: verified.issuer,
      },
    );
    await input.audit?.record("digi_session_created", {
      ownerId: outcome.ownerId,
      sessionId: outcome.sessionId,
    });
  } catch {
    /* committed state is already durable; do not hide the session */
  }

  return {
    ok: true,
    ownerId: outcome.ownerId,
    ownerCreated: outcome.created,
    sessionToken: outcome.token,
    sessionId: outcome.sessionId,
    expiresAt: outcome.expiresAt,
    subject: verified.subject,
  };
}
