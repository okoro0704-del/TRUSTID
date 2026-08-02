import { AUDIT_EVENTS, DEVICE_STATUS, isDeviceCredentialActive } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";

function formatLastActive(date: Date | null) {
  if (!date) return "Never";
  const diff = Date.now() - date.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  return date.toLocaleDateString();
}

function publicStatus(status: string) {
  if (isDeviceCredentialActive(status)) return DEVICE_STATUS.ACTIVE;
  return status;
}

export async function listDevices(userId: string) {
  const devices = await prisma.device.findMany({
    where: { userId },
    include: {
      credentials: {
        select: {
          id: true,
          status: true,
          authenticatorAttachment: true,
          credentialDeviceType: true,
          backedUp: true,
          lastUsedAt: true,
          createdAt: true,
        },
      },
    },
    orderBy: { trustedAt: "desc" },
  });
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    status: publicStatus(d.status),
    trusted: isDeviceCredentialActive(d.status),
    lastActiveAt: d.lastActiveAt?.toISOString() ?? null,
    lastActiveLabel: formatLastActive(d.lastActiveAt),
    lastUsedAt: d.lastActiveAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    deviceType: d.deviceType,
    platform: d.platform,
    trustedAt: d.trustedAt.toISOString(),
    revokedAt: d.revokedAt?.toISOString() ?? null,
    // Public credential metadata only — never private keys
    credentials: d.credentials.map((c) => ({
      id: c.id,
      status: publicStatus(c.status),
      authenticatorAttachment: c.authenticatorAttachment,
      credentialDeviceType: c.credentialDeviceType,
      backedUp: c.backedUp,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
  }));
}

export async function renameDevice(userId: string, deviceId: string, name: string) {
  const device = await prisma.device.findFirst({ where: { id: deviceId, userId } });
  if (!device || device.status === DEVICE_STATUS.REVOKED) {
    throw Object.assign(new Error("Device not found"), { statusCode: 404 });
  }
  const updated = await prisma.device.update({
    where: { id: deviceId },
    data: { name: name.trim() },
  });
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_RENAMED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { deviceId, name: updated.name },
  });
  return updated;
}

export async function revokeDevice(
  userId: string,
  deviceId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const device = await prisma.device.findFirst({ where: { id: deviceId, userId } });
  if (!device) {
    throw Object.assign(new Error("Device not found"), { statusCode: 404 });
  }
  if (device.status === DEVICE_STATUS.REVOKED) return device;

  await prisma.$transaction([
    prisma.device.update({
      where: { id: deviceId },
      data: { status: DEVICE_STATUS.REVOKED, revokedAt: new Date() },
    }),
    prisma.credential.updateMany({
      where: { deviceId, status: { not: DEVICE_STATUS.REVOKED } },
      data: { status: DEVICE_STATUS.REVOKED, revokedAt: new Date() },
    }),
    prisma.session.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_REVOKED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { deviceId },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  return prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
}

export async function createPairingRequest(
  userId: string,
  meta: Record<string, unknown>,
) {
  const request = await prisma.devicePairingRequest.create({
    data: {
      userId,
      requestingDeviceMeta: JSON.stringify(meta),
      status: "pending",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await recordAudit({
    type: AUDIT_EVENTS.PAIRING_REQUESTED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { requestId: request.id },
  });
  return {
    id: request.id,
    status: request.status,
    expiresAt: request.expiresAt.toISOString(),
    requestingDeviceMeta: meta,
  };
}

export async function listPairingRequests(userId: string) {
  const rows = await prisma.devicePairingRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    requestingDeviceMeta: JSON.parse(r.requestingDeviceMeta) as Record<string, unknown>,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }));
}

export async function resolvePairingRequest(
  userId: string,
  requestId: string,
  action: "approve" | "reject",
  approvedByDeviceId?: string,
) {
  const request = await prisma.devicePairingRequest.findFirst({
    where: { id: requestId, userId },
  });
  if (!request) {
    throw Object.assign(new Error("Request not found"), { statusCode: 404 });
  }
  if (request.status !== "pending") {
    throw Object.assign(new Error("Request already resolved"), { statusCode: 400 });
  }
  if (request.expiresAt.getTime() < Date.now()) {
    await prisma.devicePairingRequest.update({
      where: { id: requestId },
      data: { status: "expired", resolvedAt: new Date() },
    });
    throw Object.assign(new Error("Request expired"), { statusCode: 400 });
  }

  const status = action === "approve" ? "approved" : "rejected";
  const updated = await prisma.devicePairingRequest.update({
    where: { id: requestId },
    data: {
      status,
      approvedByDeviceId: action === "approve" ? approvedByDeviceId ?? null : null,
      resolvedAt: new Date(),
    },
  });

  await recordAudit({
    type:
      action === "approve"
        ? AUDIT_EVENTS.PAIRING_APPROVED
        : AUDIT_EVENTS.PAIRING_REJECTED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { requestId, approvedByDeviceId },
  });

  return updated;
}
