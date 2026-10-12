import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { deviceFingerprintHash, hashSecret } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { isStepUpSigningKey } from "../step-up/master-device-keys.js";
import { verifyMasterDeviceSignature } from "../step-up/service.js";

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
      new Error("Enroll a step-up Master Device from the Trust Center (POST /v1/step-up/master-device/enrollment)"),
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
  const fingerprintHash = deviceFingerprintHash(input.deviceFingerprint);
  const master = await prisma.masterDevice.findFirst({
    where: {
      userId: input.userId,
      deviceFingerprint: fingerprintHash,
      isMasterDevice: true,
      status: "active",
    },
  });
  if (!master) {
    throw Object.assign(new Error("Device is not a registered Master Device"), {
      statusCode: 403,
    });
  }
  // "verified" means the device signed the challenge id with its enrolled step-up key.
  if (!isStepUpSigningKey(master.publicKey) || !verifyMasterDeviceSignature(master.publicKey, input.challengeId, input.signature)) {
    throw Object.assign(new Error("Master Device signature is invalid"), { statusCode: 401 });
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
