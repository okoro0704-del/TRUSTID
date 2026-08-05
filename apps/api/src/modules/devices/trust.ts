import {
  AUDIT_EVENTS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  isDeviceCredentialActive,
} from "@trustid/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";
import { verifyReauthentication } from "../authentication/webauthn.js";

export async function ensurePrimaryDevice(userId: string) {
  const primary = await prisma.device.count({
    where: {
      userId,
      trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
    },
  });
  if (primary > 0) return;

  const first = await prisma.device.findFirst({
    where: {
      userId,
      trustLevel: { not: DEVICE_TRUST_LEVELS.TEMPORARY },
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
    },
    orderBy: { trustedAt: "asc" },
  });
  if (first) {
    await prisma.device.update({
      where: { id: first.id },
      data: { trustLevel: DEVICE_TRUST_LEVELS.PRIMARY },
    });
  }
}

export async function assertPrimaryDevice(
  userId: string,
  deviceId: string | null | undefined,
) {
  await ensurePrimaryDevice(userId);
  if (!deviceId) {
    throw Object.assign(
      new Error("Primary trusted device required for this action"),
      { statusCode: 403 },
    );
  }
  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId },
  });
  if (
    !device ||
    !isDeviceCredentialActive(device.status) ||
    device.trustLevel !== DEVICE_TRUST_LEVELS.PRIMARY
  ) {
    throw Object.assign(
      new Error("Only a primary trusted device may perform this action"),
      { statusCode: 403 },
    );
  }
  return device;
}

export async function promoteDeviceToPrimary(input: {
  userId: string;
  actorDeviceId: string | null | undefined;
  targetDeviceId: string;
  response: AuthenticationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  await assertPrimaryDevice(input.userId, input.actorDeviceId);
  await verifyReauthentication({
    userId: input.userId,
    deviceId: input.actorDeviceId ?? undefined,
    response: input.response,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const target = await prisma.device.findFirst({
    where: { id: input.targetDeviceId, userId: input.userId },
  });
  if (!target || !isDeviceCredentialActive(target.status)) {
    throw Object.assign(new Error("Device not found"), { statusCode: 404 });
  }
  if (target.trustLevel === DEVICE_TRUST_LEVELS.TEMPORARY) {
    throw Object.assign(
      new Error("Temporary devices cannot become primary. Trust the device first."),
      { statusCode: 400 },
    );
  }
  if (target.trustLevel === DEVICE_TRUST_LEVELS.PRIMARY) {
    return target;
  }

  await prisma.$transaction([
    prisma.device.updateMany({
      where: {
        userId: input.userId,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
        status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
      },
      data: { trustLevel: DEVICE_TRUST_LEVELS.STANDARD },
    }),
    prisma.device.update({
      where: { id: target.id },
      data: { trustLevel: DEVICE_TRUST_LEVELS.PRIMARY },
    }),
  ]);

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_PROMOTED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { deviceId: target.id },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_PRIMARY_CHANGED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      fromDeviceId: input.actorDeviceId,
      toDeviceId: target.id,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return prisma.device.findUniqueOrThrow({ where: { id: target.id } });
}

export async function chooseInitialTrustLevel(userId: string) {
  const trusted = await prisma.device.count({
    where: {
      userId,
      trustLevel: { in: [DEVICE_TRUST_LEVELS.PRIMARY, DEVICE_TRUST_LEVELS.STANDARD] },
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
    },
  });
  return trusted === 0
    ? DEVICE_TRUST_LEVELS.PRIMARY
    : DEVICE_TRUST_LEVELS.STANDARD;
}
