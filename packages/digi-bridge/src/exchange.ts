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
 * Digi exchange: verify TrustID assertion ? consume jti ? resolve owner ? Digi session.
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

  const consumed = await input.replay.tryConsume({
    jti: verified.jti,
    issuer: verified.issuer,
    subject: verified.subject,
    expiresAt: new Date(verified.exp * 1000),
  });
  if (!consumed) {
    await input.audit?.record("trust_assertion_replay_rejected", {
      jti: verified.jti,
    });
    return { ok: false, error: "unauthorized", reason: "replay" };
  }

  await input.audit?.record("trust_assertion_accepted", {
    jti: verified.jti,
    issuer: verified.issuer,
    audience: verified.audience,
  });

  const { owner, created, identity } = await input.owners.resolveOrCreate({
    issuer: verified.issuer,
    subject: verified.subject,
  });

  await input.audit?.record(
    created ? "digi_owner_created" : "digi_owner_resolved",
    {
      ownerId: owner.id,
      identityId: identity.id,
      issuer: verified.issuer,
    },
  );

  const { session, token } = await input.sessions.create({
    ownerId: owner.id,
  });

  await input.audit?.record("digi_session_created", {
    ownerId: owner.id,
    sessionId: session.id,
  });

  return {
    ok: true,
    ownerId: owner.id,
    ownerCreated: created,
    sessionToken: token,
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    subject: verified.subject,
  };
}
