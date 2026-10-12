/**
 * Authenticated step-up for an already signed-in TrustID subject.
 *
 * Trust boundary
 *   - The relying party (e.g. LifeOS Portal) holds a TrustID OAuth access
 *     token for the subject. It creates a challenge for ONE operation and
 *     later consumes the approval. It never approves.
 *   - The subject approves on a TrustID surface with a TrustID session: the
 *     registered Master Device signs the challenge, or 1:1 biometric
 *     verification of that same subject succeeds.
 *   - The relying party's own session is opaque here: it supplies
 *     sessionBinding (a digest of its session id) and must present the same
 *     value to consume. TrustID never treats the two sessions as one.
 *
 * Invariants
 *   - Bound to: subject, client (application), access token, client session
 *     binding, action, operation digest, expiry, method (+ Master Device).
 *   - Server-side state; 256-bit random challenge ids; 30-300 s lifetime.
 *   - Approve, deny, cancel and consume are single-transition (atomic
 *     compare-and-set on status); an approval is consumed at most once.
 *   - Another subject, client, token, session binding or operation is
 *     indistinguishable from "not found" (404) or a binding error, never a
 *     success.
 *   - The result is a short-lived signed approval for that client and
 *     operation, not a login session and not an access token.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import * as jose from "jose";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  SCOPES,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { deviceFingerprintHash } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { activeSigningKey } from "../verified-identity/assertions.js";
import { pgVectorMatcher } from "../trust-id/vector-matcher.js";
import type { BiometricPayload } from "../trust-id/schemas.js";
import { biometricStepUpPadReady, SERVER_PAD_STATUS } from "./pad-policy.js";

export const STEP_UP_METHODS = ["master_device", "biometric"] as const;
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

export const STEP_UP_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
  CANCELLED: "cancelled",
  CONSUMED: "consumed",
  EXPIRED: "expired",
} as const;

export const STEP_UP_TTL = { DEFAULT: 120, MIN: 30, MAX: 300 } as const;
export const STEP_UP_APPROVAL_TTL_SECONDS = 60;
export const STEP_UP_MAX_FAILED_ATTEMPTS = 3;
export const STEP_UP_APPROVAL_TYP = "trustid-step-up+jwt";
export const STEP_UP_SIGNING_VERSION = "trustid-step-up/v1";

/** "domain.purchase", "users.role:write" ... */
export const ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{1,99}$/;
/** SHA-256 as base64url (43 chars) or lowercase hex (64 chars). */
export const DIGEST_PATTERN = /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{64})$/;

export class StepUpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StepUpError";
  }
}

const fail = (statusCode: number, code: string, message: string): never => {
  throw new StepUpError(statusCode, code, message);
};

/** The relying party's view of its bearer token (from resolveAccessToken). */
export type ClientAccess = {
  tokenId: string;
  userId: string;
  trustId: string;
  applicationId: string;
  clientId: string;
  scopes: string[];
};

/** The subject's TrustID session on the approving surface. */
export type SubjectSession = { userId: string; sessionId?: string };

type ChallengeRow = NonNullable<Awaited<ReturnType<typeof prisma.stepUpChallenge.findUnique>>>;

function effectiveStatus(row: Pick<ChallengeRow, "status" | "expiresAt">, now = new Date()): string {
  if ((row.status === STEP_UP_STATUS.PENDING || row.status === STEP_UP_STATUS.APPROVED) && row.expiresAt <= now) {
    return STEP_UP_STATUS.EXPIRED;
  }
  return row.status;
}

export function stepUpSigningPayload(input: {
  challengeId: string;
  trustId: string;
  clientId: string;
  action: string;
  operationDigest: string;
  sessionBinding: string;
  masterDeviceId: string | null;
  expiresAt: Date;
}): string {
  // Newline-separated, fixed order: the Master Device signs these exact bytes.
  return [
    STEP_UP_SIGNING_VERSION,
    `challenge=${input.challengeId}`,
    `sub=${input.trustId}`,
    `client=${input.clientId}`,
    `action=${input.action}`,
    `operation=${input.operationDigest}`,
    `session=${createHash("sha256").update(input.sessionBinding).digest("base64url")}`,
    `device=${input.masterDeviceId ?? "-"}`,
    `exp=${input.expiresAt.toISOString()}`,
  ].join("\n");
}

function publicView(row: ChallengeRow, clientName?: string) {
  return {
    challenge_id: row.challengeId,
    status: effectiveStatus(row),
    method: row.method,
    action: row.action,
    operation_digest: row.operationDigest,
    expires_at: row.expiresAt.toISOString(),
    ...(clientName ? { client_name: clientName } : {}),
  };
}

function requireStepUpScope(access: ClientAccess) {
  if (!access.scopes.includes(SCOPES.IDENTITY_STEP_UP)) {
    fail(403, "insufficient_scope", `Access token lacks the ${SCOPES.IDENTITY_STEP_UP} scope.`);
  }
}

/** Relying party: create a challenge for one operation of its signed-in subject. */
export async function createStepUpChallenge(
  access: ClientAccess,
  input: {
    method: StepUpMethod;
    action: string;
    operationDigest: string;
    sessionBinding: string;
    ttlSeconds?: number;
  },
  meta: { ip?: string; userAgent?: string } = {},
) {
  requireStepUpScope(access);
  if (!STEP_UP_METHODS.includes(input.method)) fail(400, "invalid_request", "Unknown step-up method.");
  if (!ACTION_PATTERN.test(input.action)) fail(400, "invalid_request", "action must match " + ACTION_PATTERN.source);
  if (!DIGEST_PATTERN.test(input.operationDigest)) fail(400, "invalid_request", "operation_digest must be a SHA-256 digest.");
  if (!DIGEST_PATTERN.test(input.sessionBinding)) fail(400, "invalid_request", "session_binding must be a SHA-256 digest.");
  const ttl = input.ttlSeconds ?? STEP_UP_TTL.DEFAULT;
  if (!Number.isInteger(ttl) || ttl < STEP_UP_TTL.MIN || ttl > STEP_UP_TTL.MAX) {
    fail(400, "invalid_request", `ttl_seconds must be ${STEP_UP_TTL.MIN}-${STEP_UP_TTL.MAX}.`);
  }

  let masterDeviceId: string | null = null;
  if (input.method === "master_device") {
    const master = await prisma.masterDevice.findFirst({
      where: { userId: access.userId, isMasterDevice: true, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    if (!master) fail(409, "master_device_not_registered", "This TrustID has no registered Master Device.");
    masterDeviceId = master!.id;
  } else {
    const face = await prisma.biometricEmbedding.findFirst({
      where: { userId: access.userId, modality: BIOMETRIC_MODALITIES.FACE, status: "active" },
      select: { id: true },
    });
    if (!face) fail(409, "biometric_not_enrolled", "This TrustID has no enrolled face template.");
  }

  const challengeId = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const row = await prisma.stepUpChallenge.create({
    data: {
      challengeId,
      userId: access.userId,
      trustId: access.trustId,
      applicationId: access.applicationId,
      accessTokenId: access.tokenId,
      sessionBinding: input.sessionBinding,
      action: input.action,
      operationDigest: input.operationDigest,
      method: input.method,
      masterDeviceId,
      signingPayload: stepUpSigningPayload({
        challengeId,
        trustId: access.trustId,
        clientId: access.clientId,
        action: input.action,
        operationDigest: input.operationDigest,
        sessionBinding: input.sessionBinding,
        masterDeviceId,
        expiresAt,
      }),
      expiresAt,
    },
  });
  await recordAudit({
    type: "step_up.challenge_created",
    userId: access.userId,
    actorType: "application",
    actorId: access.clientId,
    metadata: { challengeId: hashId(challengeId), action: input.action, method: input.method },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return publicView(row);
}

/** Audit never stores the raw challenge id. */
function hashId(challengeId: string) {
  return createHash("sha256").update(challengeId).digest("base64url").slice(0, 16);
}

/** A challenge as the relying party may see it: same client and subject, else not found. */
async function clientChallenge(access: ClientAccess, challengeId: string): Promise<ChallengeRow> {
  const row = await prisma.stepUpChallenge.findUnique({ where: { challengeId } });
  if (!row || row.applicationId !== access.applicationId || row.userId !== access.userId) {
    fail(404, "challenge_not_found", "Step-up challenge not found.");
  }
  return row!;
}

export async function getStepUpChallenge(access: ClientAccess, challengeId: string) {
  requireStepUpScope(access);
  return publicView(await clientChallenge(access, challengeId));
}

export async function cancelStepUpChallenge(access: ClientAccess, challengeId: string) {
  requireStepUpScope(access);
  const row = await clientChallenge(access, challengeId);
  const done = await prisma.stepUpChallenge.updateMany({
    where: {
      id: row.id,
      status: { in: [STEP_UP_STATUS.PENDING, STEP_UP_STATUS.APPROVED] },
      consumedAt: null,
    },
    data: { status: STEP_UP_STATUS.CANCELLED, resolvedAt: new Date() },
  });
  if (done.count !== 1) fail(409, "challenge_not_cancellable", `Challenge is ${effectiveStatus(row)}.`);
  return { challenge_id: row.challengeId, status: STEP_UP_STATUS.CANCELLED };
}

/**
 * Relying party: exchange an approved challenge for a one-time signed approval.
 * Must present the same access token, client session binding and operation.
 */
export async function consumeStepUpChallenge(
  access: ClientAccess,
  challengeId: string,
  input: { sessionBinding: string; operationDigest: string },
) {
  requireStepUpScope(access);
  const row = await clientChallenge(access, challengeId);
  if (row.accessTokenId !== access.tokenId) {
    fail(403, "session_binding_mismatch", "Challenge was created under a different TrustID authorization.");
  }
  if (row.sessionBinding !== input.sessionBinding) {
    fail(403, "session_binding_mismatch", "Challenge is bound to a different client session.");
  }
  if (row.operationDigest !== input.operationDigest) {
    fail(403, "operation_mismatch", "Challenge was approved for a different operation.");
  }
  const status = effectiveStatus(row);
  if (status !== STEP_UP_STATUS.APPROVED) {
    fail(409, status === STEP_UP_STATUS.CONSUMED ? "challenge_already_consumed" : "challenge_not_approved", `Challenge is ${status}.`);
  }

  const consumedAt = new Date();
  const won = await prisma.stepUpChallenge.updateMany({
    where: { id: row.id, status: STEP_UP_STATUS.APPROVED, consumedAt: null, expiresAt: { gt: consumedAt } },
    data: { status: STEP_UP_STATUS.CONSUMED, consumedAt },
  });
  if (won.count !== 1) fail(409, "challenge_already_consumed", "Challenge was already consumed.");

  const evidence = row.approvalEvidence ? (JSON.parse(row.approvalEvidence) as Record<string, unknown>) : {};
  const key = await activeSigningKey();
  const approval = await new jose.SignJWT({
    azp: access.clientId,
    action: row.action,
    operation_digest: row.operationDigest,
    session_binding: row.sessionBinding,
    method: row.method,
    amr: row.method === "master_device" ? ["hwk"] : ["face"],
    approved_at: row.approvedAt ? Math.floor(row.approvedAt.getTime() / 1000) : undefined,
    assurance: evidence.assurance,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: STEP_UP_APPROVAL_TYP })
    .setIssuer(config.oidcIssuer)
    .setSubject(row.trustId)
    .setAudience(access.clientId)
    .setJti(row.challengeId)
    .setIssuedAt()
    .setExpirationTime(`${STEP_UP_APPROVAL_TTL_SECONDS}s`)
    .sign(key.privateKey);

  await recordAudit({
    type: "step_up.challenge_consumed",
    userId: row.userId,
    actorType: "application",
    actorId: access.clientId,
    metadata: { challengeId: hashId(row.challengeId), action: row.action, method: row.method },
  });
  return {
    challenge_id: row.challengeId,
    status: STEP_UP_STATUS.CONSUMED,
    approval,
    token_type: "urn:trustid:step-up-approval",
    expires_in: STEP_UP_APPROVAL_TTL_SECONDS,
  };
}

/** A challenge as its subject may see it: same subject, else not found. */
async function subjectChallenge(session: SubjectSession, challengeId: string): Promise<ChallengeRow> {
  const row = await prisma.stepUpChallenge.findUnique({ where: { challengeId } });
  if (!row || row.userId !== session.userId) fail(404, "challenge_not_found", "Step-up challenge not found.");
  return row!;
}

function requirePending(row: ChallengeRow) {
  const status = effectiveStatus(row);
  if (status !== STEP_UP_STATUS.PENDING) {
    fail(status === STEP_UP_STATUS.EXPIRED ? 410 : 409, status === STEP_UP_STATUS.EXPIRED ? "challenge_expired" : "challenge_not_pending", `Challenge is ${status}.`);
  }
}

/** Subject: challenges waiting for this subject's approval. */
export async function listPendingStepUps(session: SubjectSession) {
  const rows = await prisma.stepUpChallenge.findMany({
    where: { userId: session.userId, status: STEP_UP_STATUS.PENDING, expiresAt: { gt: new Date() } },
    include: { application: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((row) => ({
    ...publicView(row, row.application.name),
    ...(row.method === "master_device" ? { signing_payload: row.signingPayload } : {}),
  }));
}

async function recordFailedAttempt(row: ChallengeRow) {
  await prisma.stepUpChallenge.updateMany({
    where: { id: row.id, status: STEP_UP_STATUS.PENDING },
    data: { failedAttempts: { increment: 1 } },
  });
  await prisma.stepUpChallenge.updateMany({
    where: { id: row.id, status: STEP_UP_STATUS.PENDING, failedAttempts: { gte: STEP_UP_MAX_FAILED_ATTEMPTS } },
    data: { status: STEP_UP_STATUS.DENIED, resolvedAt: new Date() },
  });
}

async function markApproved(row: ChallengeRow, evidence: Record<string, unknown>) {
  const now = new Date();
  const won = await prisma.stepUpChallenge.updateMany({
    where: { id: row.id, status: STEP_UP_STATUS.PENDING, expiresAt: { gt: now } },
    data: {
      status: STEP_UP_STATUS.APPROVED,
      approvedAt: now,
      resolvedAt: now,
      approvalEvidence: JSON.stringify(evidence),
    },
  });
  if (won.count !== 1) fail(409, "challenge_not_pending", "Challenge is no longer pending.");
  await recordAudit({
    type: "step_up.challenge_approved",
    userId: row.userId,
    actorType: "user",
    actorId: row.userId,
    metadata: { challengeId: hashId(row.challengeId), action: row.action, method: row.method },
  });
  return { challenge_id: row.challengeId, status: STEP_UP_STATUS.APPROVED };
}

/** Verify an ECDSA P-256 / SHA-256 signature (DER or raw r||s) with an SPKI public key. */
export function verifyMasterDeviceSignature(publicKeySpki: Uint8Array, message: string, signatureB64: string): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, signatureB64.includes("+") || signatureB64.includes("/") ? "base64" : "base64url");
  } catch {
    return false;
  }
  if (signature.length < 8 || signature.length > 160) return false;
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeySpki), format: "der", type: "spki" });
  } catch {
    return false;
  }
  if (key.asymmetricKeyType !== "ec") return false;
  const data = Buffer.from(message, "utf8");
  for (const dsaEncoding of ["der", "ieee-p1363"] as const) {
    try {
      if (cryptoVerify("sha256", data, { key, dsaEncoding }, signature)) return true;
    } catch {
      /* wrong encoding for this signature: try the other */
    }
  }
  return false;
}

/** Subject: approve with the registered Master Device's signature over signing_payload. */
export async function approveWithMasterDevice(
  session: SubjectSession,
  challengeId: string,
  input: { deviceFingerprint: string; signature: string },
) {
  const row = await subjectChallenge(session, challengeId);
  if (row.method !== "master_device") fail(400, "wrong_method", "This challenge is not a Master Device challenge.");
  requirePending(row);

  let fingerprint: string;
  try {
    fingerprint = deviceFingerprintHash(input.deviceFingerprint);
  } catch {
    return fail(400, "invalid_request", "device_fingerprint is required.");
  }
  const master = await prisma.masterDevice.findFirst({
    where: { id: row.masterDeviceId ?? "", userId: row.userId, isMasterDevice: true, status: "active" },
  });
  if (!master || master.deviceFingerprint !== fingerprint) {
    await recordFailedAttempt(row);
    fail(403, "wrong_master_device", "This device is not the Master Device for this challenge.");
  }
  if (!verifyMasterDeviceSignature(master!.publicKey, row.signingPayload, input.signature)) {
    await recordFailedAttempt(row);
    fail(401, "invalid_signature", "Master Device signature is invalid.");
  }
  await prisma.masterDevice.update({ where: { id: master!.id }, data: { lastVerifiedAt: new Date() } });
  return markApproved(row, { method: "master_device", masterDeviceId: master!.id });
}

/**
 * Subject: approve with 1:1 biometric verification of the challenge's own
 * subject. Never 1:N: another person's face cannot approve, and a failure of
 * any kind (PAD unavailable, model mismatch, service down, no match) never
 * approves.
 */
export async function approveWithBiometric(
  session: SubjectSession,
  challengeId: string,
  biometric: BiometricPayload,
) {
  const row = await subjectChallenge(session, challengeId);
  if (row.method !== "biometric") fail(400, "wrong_method", "This challenge is not a biometric challenge.");
  requirePending(row);
  if (!biometricStepUpPadReady()) {
    fail(503, "step_up_pad_unavailable", `Biometric step-up is unavailable: presentation-attack detection is ${SERVER_PAD_STATUS}.`);
  }
  if (biometric.modality !== BIOMETRIC_MODALITIES.FACE || biometric.vector?.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    fail(400, "invalid_biometric", "A 512-D face vector from the TrustID engine is required.");
  }

  let result;
  try {
    result = await pgVectorMatcher.verifyOneToOne({ claimedTrustId: row.trustId, biometric });
  } catch {
    return fail(503, "biometric_service_unavailable", "Biometric verification is temporarily unavailable.");
  }
  if (!result.matched) {
    const code = result.errorCode;
    if (code && code !== BIOMETRIC_ERROR_CODES.NO_MATCH) {
      // Model/template/threshold/service problems are not a "no match" and do not count as attempts.
      fail(code === BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE ? 503 : 422, code.toLowerCase(), "Biometric verification could not be performed.");
    }
    await recordFailedAttempt(row);
    fail(401, "biometric_no_match", "The face does not match this TrustID.");
  }
  if (result.userId && result.userId !== row.userId) {
    await recordFailedAttempt(row);
    fail(401, "biometric_no_match", "The face does not match this TrustID.");
  }
  return markApproved(row, {
    method: "biometric",
    assurance: { pad: SERVER_PAD_STATUS, threshold: result.thresholdStatus ?? "UNCALIBRATED" },
  });
}

/** Subject: refuse a pending challenge. */
export async function denyStepUp(session: SubjectSession, challengeId: string) {
  const row = await subjectChallenge(session, challengeId);
  requirePending(row);
  const done = await prisma.stepUpChallenge.updateMany({
    where: { id: row.id, status: STEP_UP_STATUS.PENDING },
    data: { status: STEP_UP_STATUS.DENIED, resolvedAt: new Date() },
  });
  if (done.count !== 1) fail(409, "challenge_not_pending", "Challenge is no longer pending.");
  return { challenge_id: row.challengeId, status: STEP_UP_STATUS.DENIED };
}
