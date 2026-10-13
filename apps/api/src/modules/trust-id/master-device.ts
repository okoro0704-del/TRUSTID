import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { deviceFingerprintHash, hashSecret } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { isStepUpSigningKey } from "../step-up/master-device-keys.js";
import { verifyMasterDeviceSignature } from "../step-up/service.js";
import { activeStepUpDevice } from "../step-up/master-device-keys.js";
import { legacyChallengeSigningPayload } from "./challenges.js";
import { MASTER_AUTH_CHALLENGE_STATUS } from "@trustid/shared";

export async function registerMasterDevice(input: {
  userId: string;
  deviceFingerprint: string;
  publicKey: string;
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}) {
  const fingerprintHash = deviceFingerprintHash(input.deviceFingerprint);
  const publicKeyBytes = Buffer.from(input.publicKey, "base64url");

  // Step-up signing keys (ECDSA P-256) are enrolled only through the step-up enrollment ceremony
  // (passkey re-authentication + proof of possession). This terminal binding path never writes one
  // and never overwrites one.
  if (isStepUpSigningKey(publicKeyBytes)) {
    throw Object.assign(
      new Error("Adding a new Master Device is temporarily unavailable while a security update is completed. Phones already set up keep working."),
      { statusCode: 409, code: "master_device_enrollment_required" },
    );
  }

  const existing = await prisma.masterDevice.findUnique({
    where: { deviceFingerprint: fingerprintHash },
  });
  if (existing && existing.userId !== input.userId) {
    throw Object.assign(
      new Error("This device is already bound to another Trust ID"),
      { statusCode: 409 },
    );
  }
  if (existing && isStepUpSigningKey(existing.publicKey)) {
    throw Object.assign(
      new Error("This device holds an enrolled step-up Master Device key"),
      { statusCode: 409, code: "master_device_enrolled" },
    );
  }

  const row = await prisma.masterDevice.upsert({
    where: { deviceFingerprint: fingerprintHash },
    create: {
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      deviceFingerprint: fingerprintHash,
      publicKey: publicKeyBytes,
      isMasterDevice: true,
      lastVerifiedAt: new Date(),
      status: "active",
    },
    update: {
      publicKey: publicKeyBytes,
      deviceId: input.deviceId ?? undefined,
      isMasterDevice: true,
      lastVerifiedAt: new Date(),
      status: "active",
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.MASTER_DEVICE_REGISTERED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { masterDeviceId: row.id },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { masterDeviceId: row.id, isMasterDevice: true };
}

export async function verifyMasterDeviceBinding(input: {
  userId: string;
  deviceFingerprint: string;
  challengeId: string;
  signature: string;
  ip?: string;
  userAgent?: string;
}) {
  // "verified" means: the subject's enrolled step-up Master Device signed THIS issued challenge
  // (server nonce, owner, action, payload hash, expiry), and the challenge is used up by it. A
  // signature over a value the client picks would verify forever once captured.
  const challenge = await prisma.masterAuthChallenge.findFirst({
    where: { challengeId: input.challengeId, userId: input.userId },
  });
  if (!challenge) {
    throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
  }
  if (challenge.status !== MASTER_AUTH_CHALLENGE_STATUS.PENDING || challenge.expiresAt.getTime() <= Date.now()) {
    throw Object.assign(new Error("Challenge is no longer pending"), { statusCode: 409 });
  }
  let fingerprintHash = "";
  try {
    fingerprintHash = deviceFingerprintHash(input.deviceFingerprint);
  } catch {
    /* rejected below */
  }
  const master = await activeStepUpDevice(input.userId);
  if (!master || master.deviceFingerprint !== fingerprintHash) {
    throw Object.assign(new Error("Device is not a registered Master Device"), {
      statusCode: 403,
    });
  }
  if (!isStepUpSigningKey(master.publicKey) || !verifyMasterDeviceSignature(master.publicKey, legacyChallengeSigningPayload(challenge), input.signature)) {
    throw Object.assign(new Error("Master Device signature is invalid"), { statusCode: 401 });
  }
  const won = await prisma.masterAuthChallenge.updateMany({
    where: { challengeId: challenge.challengeId, status: MASTER_AUTH_CHALLENGE_STATUS.PENDING, expiresAt: { gt: new Date() } },
    data: { status: MASTER_AUTH_CHALLENGE_STATUS.APPROVED, approvalSignatureHash: hashSecret(input.signature), approvedAt: new Date() },
  });
  if (won.count !== 1) {
    throw Object.assign(new Error("Challenge is no longer pending"), { statusCode: 409 });
  }

  const sigHash = hashSecret(input.signature);
  await prisma.masterDevice.update({
    where: { id: master.id },
    data: { lastVerifiedAt: new Date() },
  });

  await recordAudit({
    type: AUDIT_EVENTS.MASTER_DEVICE_VERIFIED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { masterDeviceId: master.id, challengeId: input.challengeId },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { verified: true, masterDeviceId: master.id, signatureHash: sigHash };
}

export async function getMasterDeviceForUser(userId: string) {
  return prisma.masterDevice.findFirst({
    where: { userId, isMasterDevice: true, status: "active" },
  });
}
