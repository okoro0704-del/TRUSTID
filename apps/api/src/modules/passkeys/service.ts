import { AUDIT_EVENTS, DEVICE_STATUS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";

export async function listPasskeys(userId: string) {
  const creds = await prisma.credential.findMany({
    where: { userId },
    include: { device: true },
    orderBy: { createdAt: "desc" },
  });
  return creds.map((c) => ({
    id: c.id,
    displayName: c.displayName || c.device.name || "Passkey",
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    authenticatorAttachment: c.authenticatorAttachment,
    credentialDeviceType: c.credentialDeviceType,
    backedUp: c.backedUp,
    device: {
      id: c.device.id,
      name: c.device.name,
      status: c.device.status,
    },
  }));
}

export async function renamePasskey(userId: string, passkeyId: string, displayName: string) {
  const cred = await prisma.credential.findFirst({
    where: { id: passkeyId, userId },
  });
  if (!cred || cred.status === DEVICE_STATUS.REVOKED) {
    throw Object.assign(new Error("Passkey not found"), { statusCode: 404 });
  }
  const updated = await prisma.credential.update({
    where: { id: passkeyId },
    data: { displayName: displayName.trim() },
  });
  await recordAudit({
    type: AUDIT_EVENTS.PASSKEY_RENAMED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { passkeyId, displayName: updated.displayName },
  });
  return updated;
}

export async function removePasskey(
  userId: string,
  passkeyId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const cred = await prisma.credential.findFirst({
    where: { id: passkeyId, userId },
    include: { device: true },
  });
  if (!cred) {
    throw Object.assign(new Error("Passkey not found"), { statusCode: 404 });
  }
  if (cred.status === DEVICE_STATUS.REVOKED) return cred;

  const remaining = await prisma.credential.count({
    where: {
      userId,
      status: { not: DEVICE_STATUS.REVOKED },
      id: { not: passkeyId },
    },
  });
  if (remaining < 1) {
    throw Object.assign(
      new Error("Cannot remove the last passkey. Add another trusted device first."),
      { statusCode: 400 },
    );
  }

  await prisma.$transaction([
    prisma.credential.update({
      where: { id: passkeyId },
      data: { status: DEVICE_STATUS.REVOKED, revokedAt: new Date() },
    }),
    // If device has no other active credentials, revoke the device too
    prisma.session.updateMany({
      where: { deviceId: cred.deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  const otherOnDevice = await prisma.credential.count({
    where: {
      deviceId: cred.deviceId,
      status: { not: DEVICE_STATUS.REVOKED },
    },
  });
  if (otherOnDevice === 0) {
    await prisma.device.update({
      where: { id: cred.deviceId },
      data: { status: DEVICE_STATUS.REVOKED, revokedAt: new Date() },
    });
  }

  await recordAudit({
    type: AUDIT_EVENTS.PASSKEY_REMOVED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { passkeyId, deviceId: cred.deviceId },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  return prisma.credential.findUniqueOrThrow({ where: { id: passkeyId } });
}
