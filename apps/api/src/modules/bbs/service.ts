import { AUDIT_EVENTS, DEVICE_TRUST_LEVELS, SCOPES } from "@trustid/shared";
import type { ZkClaimBundle } from "@trustid/zk";
import { provePaymentStepUp, verifyZkClaimBundle } from "@trustid/zk";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import {
  bbsPaymentNullifier,
  hashPaymentContext,
  hashSecret,
  identitySecretForUser,
  signBbsMasterApproval,
  verifyBbsMasterApproval,
} from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { BBS_STEP_UP_STATUS, type BbsInitiateInput, type BbsVerifyInput } from "./schemas.js";

export class BbsError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code = "bbs_error",
  ) {
    super(message);
    this.name = "BbsError";
  }
}

function assertBbsScope(scopes: string[]) {
  if (!scopes.includes(SCOPES.IDENTITY_BBS_STEP_UP)) {
    throw new BbsError("Missing identity.bbs_step_up scope", 403, "forbidden");
  }
}

function ttlMinutes() {
  return Number(process.env.BBS_STEP_UP_TTL_MINUTES ?? 5);
}

function oobThresholdMinor() {
  return BigInt(process.env.BBS_OOB_THRESHOLD_MINOR ?? "500000");
}

function toChallenge(row: {
  challengeId: string;
  correlationId: string;
  expiresAt: Date;
  paymentHash: string;
  status: string;
  audience: string;
  paymentNullifier: string | null;
  deviceApprovalRequestId: string | null;
}) {
  return {
    challengeId: row.challengeId,
    correlationId: row.correlationId,
    expiresAt: row.expiresAt.toISOString(),
    paymentHash: row.paymentHash,
    status: row.status as keyof typeof BBS_STEP_UP_STATUS,
    audience: row.audience,
    paymentNullifier: row.paymentNullifier ?? undefined,
    deviceApprovalRequestId: row.deviceApprovalRequestId,
  };
}

export async function expireBbsChallengeIfNeeded(row: {
  challengeId: string;
  userId: string;
  status: string;
  expiresAt: Date;
}) {
  if (
    row.status !== BBS_STEP_UP_STATUS.PENDING &&
    row.status !== BBS_STEP_UP_STATUS.OOB_REQUIRED
  ) {
    return false;
  }
  if (row.expiresAt.getTime() >= Date.now()) return false;

  await prisma.bbsStepUpChallenge.update({
    where: { challengeId: row.challengeId },
    data: { status: BBS_STEP_UP_STATUS.EXPIRED },
  });
  await recordAudit({
    type: AUDIT_EVENTS.BBS_STEP_UP_EXPIRED,
    userId: row.userId,
    actorType: "system",
    metadata: { challengeId: row.challengeId },
  });
  return true;
}

export async function initiateBbsStepUp(input: {
  userId: string;
  applicationId?: string;
  scopes: string[];
  body: BbsInitiateInput;
  deviceId?: string | null;
  ip?: string;
  userAgent?: string;
}) {
  assertBbsScope(input.scopes);

  const appRow = input.applicationId
    ? await prisma.application.findUnique({ where: { id: input.applicationId } })
    : null;
  const audience = input.body.audience ?? appRow?.clientId ?? "finprov";

  const paymentHash =
    input.body.paymentHash ??
    hashPaymentContext({
      amountMinor: input.body.amountMinor,
      currency: input.body.currency,
      merchantRef: input.body.merchantRef,
      reference: input.body.reference,
      intentId: input.body.intentId,
    });

  const secret = identitySecretForUser(input.userId);
  const expiresAt = new Date(Date.now() + ttlMinutes() * 60 * 1000);

  let requiresOob = input.body.requireOob === true;
  if (!requiresOob && input.body.amountMinor != null) {
    requiresOob = BigInt(input.body.amountMinor) >= oobThresholdMinor();
  }
  if (!requiresOob && input.deviceId) {
    const device = await prisma.device.findFirst({
      where: { id: input.deviceId, userId: input.userId },
    });
    if (device?.trustLevel === DEVICE_TRUST_LEVELS.TEMPORARY) {
      requiresOob = true;
    }
  }

  const row = await prisma.bbsStepUpChallenge.create({
    data: {
      userId: input.userId,
      applicationId: input.applicationId ?? null,
      paymentHash,
      amountMinor:
        input.body.amountMinor != null ? BigInt(input.body.amountMinor) : null,
      currency: input.body.currency ?? null,
      merchantRef: input.body.merchantRef ?? null,
      audience,
      status: requiresOob
        ? BBS_STEP_UP_STATUS.OOB_REQUIRED
        : BBS_STEP_UP_STATUS.PENDING,
      expiresAt,
    },
  });

  const paymentNullifier = bbsPaymentNullifier(
    secret,
    row.challengeId,
    paymentHash,
  );
  const updated = await prisma.bbsStepUpChallenge.update({
    where: { id: row.id },
    data: { paymentNullifier },
  });

  await recordAudit({
    type: requiresOob
      ? AUDIT_EVENTS.BBS_STEP_UP_OOB_REQUIRED
      : AUDIT_EVENTS.BBS_STEP_UP_INITIATED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      challengeId: updated.challengeId,
      correlationId: updated.correlationId,
      paymentHash,
      requiresOob,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return toChallenge(updated);
}

async function loadChallenge(challengeId: string, userId?: string) {
  const row = await prisma.bbsStepUpChallenge.findUnique({
    where: { challengeId },
  });
  if (!row) {
    throw new BbsError("Step-up challenge not found", 404, "not_found");
  }
  if (userId && row.userId !== userId) {
    throw new BbsError("Step-up challenge not found", 404, "not_found");
  }
  await expireBbsChallengeIfNeeded(row);
  const fresh = await prisma.bbsStepUpChallenge.findUniqueOrThrow({
    where: { challengeId },
  });
  return fresh;
}

export async function getBbsChallengeStatus(challengeId: string, userId?: string) {
  const row = await loadChallenge(challengeId, userId);
  return toChallenge(row);
}

export async function confirmBbsStepUp(input: {
  userId: string;
  challengeId: string;
  deviceId?: string | null;
  scopes?: string[];
}) {
  const row = await loadChallenge(input.challengeId, input.userId);
  if (row.status === BBS_STEP_UP_STATUS.APPROVED) {
    return toChallenge(row);
  }
  if (
    row.status !== BBS_STEP_UP_STATUS.PENDING &&
    row.status !== BBS_STEP_UP_STATUS.OOB_REQUIRED
  ) {
    throw new BbsError(`Challenge is ${row.status}`, 409, "invalid_state");
  }

  return approveBbsStepUp({
    userId: input.userId,
    challengeId: input.challengeId,
    deviceId: input.deviceId,
  });
}

export async function approveBbsStepUp(input: {
  userId: string;
  challengeId: string;
  deviceId?: string | null;
}) {
  const row = await loadChallenge(input.challengeId, input.userId);
  if (row.status === BBS_STEP_UP_STATUS.APPROVED) {
    return {
      challenge: toChallenge(row),
      proof: row.zkProofJson ? (JSON.parse(row.zkProofJson) as ZkClaimBundle) : null,
      masterSignature: null,
    };
  }
  if (
    row.status !== BBS_STEP_UP_STATUS.PENDING &&
    row.status !== BBS_STEP_UP_STATUS.OOB_REQUIRED
  ) {
    throw new BbsError(`Challenge is ${row.status}`, 409, "invalid_state");
  }

  const secret = identitySecretForUser(input.userId);
  const nullifier =
    row.paymentNullifier ??
    bbsPaymentNullifier(secret, row.challengeId, row.paymentHash);
  const issuedAt = new Date().toISOString();
  const zkProof = provePaymentStepUp({
    challengeId: row.challengeId,
    paymentHash: row.paymentHash,
    nullifier,
    audience: row.audience,
    authorized: true,
    issuerSecret: config.sealKey,
    issuedAt,
  });
  const masterSignature = signBbsMasterApproval(config.sealKey, {
    challengeId: row.challengeId,
    paymentHash: row.paymentHash,
    nullifier,
  });

  const updated = await prisma.bbsStepUpChallenge.update({
    where: { challengeId: row.challengeId },
    data: {
      status: BBS_STEP_UP_STATUS.APPROVED,
      paymentNullifier: nullifier,
      masterSignatureHash: hashSecret(masterSignature),
      zkProofJson: JSON.stringify(zkProof),
      approvedAt: new Date(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.BBS_STEP_UP_APPROVED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      challengeId: row.challengeId,
      correlationId: row.correlationId,
      deviceId: input.deviceId ?? null,
    },
  });

  return {
    challenge: toChallenge(updated),
    proof: zkProof,
    masterSignature,
  };
}

export async function verifyBbsStepUpProof(input: BbsVerifyInput) {
  const row = await loadChallenge(input.challengeId);
  if (row.status !== BBS_STEP_UP_STATUS.APPROVED) {
    return {
      valid: false,
      challengeId: row.challengeId,
      status: row.status,
      reason: "challenge_not_approved",
    };
  }

  const nullifier =
    row.paymentNullifier ??
    input.zkProof.nullifier ??
    "";
  const signatureOk = verifyBbsMasterApproval(
    config.sealKey,
    {
      challengeId: row.challengeId,
      paymentHash: row.paymentHash,
      nullifier,
    },
    input.masterSignature,
  );
  if (!signatureOk) {
    return {
      valid: false,
      challengeId: row.challengeId,
      status: BBS_STEP_UP_STATUS.DENIED,
      reason: "master_signature_invalid",
    };
  }

  const zk = verifyZkClaimBundle(input.zkProof as ZkClaimBundle, config.sealKey);
  if (!zk.valid || input.zkProof.claimType !== "payment_step_up") {
    return {
      valid: false,
      challengeId: row.challengeId,
      status: BBS_STEP_UP_STATUS.DENIED,
      reason: zk.reason ?? "zk_invalid",
    };
  }

  if (row.masterSignatureHash && row.masterSignatureHash !== hashSecret(input.masterSignature)) {
    return {
      valid: false,
      challengeId: row.challengeId,
      status: BBS_STEP_UP_STATUS.DENIED,
      reason: "signature_mismatch",
    };
  }

  return {
    valid: true,
    challengeId: row.challengeId,
    status: BBS_STEP_UP_STATUS.APPROVED,
    paymentHash: row.paymentHash,
    paymentNullifier: nullifier,
  };
}
