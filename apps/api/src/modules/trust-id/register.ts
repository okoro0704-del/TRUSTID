import { createHash } from "node:crypto";
import { DEVICE_STATUS, DEVICE_TRUST_LEVELS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import {
  HEADS_UP_CHANNEL_ID,
  registerDevicePushToken,
} from "../notifications/push.js";
import { getDashboardIdentity } from "../identity/service.js";
import { createSession } from "../sessions/service.js";
import { autoEnrollFromBiometrics, type MultiModalPayload } from "./fusion.js";
import { registerMasterDevice } from "./master-device.js";

function placeholderMasterPublicKey(seed: string): string {
  return createHash("sha256")
    .update(`trustid-master-bind:${seed}`)
    .digest("base64url");
}

/**
 * Explicit create-consent path: mint Trust ID, bind this terminal as Master,
 * store FCM token when provided, and issue a session.
 */
export async function registerTrustIdWithMasterDevice(input: {
  payload: MultiModalPayload;
  installId?: string;
  deviceName?: string;
  deviceFingerprint?: string;
  pushToken?: string;
  pushPlatform?: string;
  ip?: string;
  userAgent?: string;
}) {
  const face = input.payload.face;
  if (!face?.vector && !face?.embedding) {
    throw Object.assign(
      new Error("Face scan required to create a Trust ID"),
      { statusCode: 400, code: "face_required" },
    );
  }

  const created = await autoEnrollFromBiometrics({
    payload: {
      ...input.payload,
      deviceFingerprint:
        input.deviceFingerprint ||
        input.payload.deviceFingerprint ||
        face?.deviceFingerprint ||
        input.installId,
    },
    installId: input.installId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await prisma.device.update({
    where: { id: created.deviceId },
    data: {
      name: (input.deviceName || "Master Phone").slice(0, 120),
      trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      status: DEVICE_STATUS.ACTIVE,
      lastActiveAt: new Date(),
      trustedAt: new Date(),
    },
  });

  const fingerprintSeed =
    input.deviceFingerprint ||
    input.payload.deviceFingerprint ||
    face?.deviceFingerprint ||
    input.installId ||
    created.deviceId;

  await prisma.masterDevice.updateMany({
    where: { userId: created.userId, isMasterDevice: true },
    data: { isMasterDevice: false, status: "superseded" },
  });

  const master = await registerMasterDevice({
    userId: created.userId,
    deviceFingerprint: fingerprintSeed,
    publicKey: placeholderMasterPublicKey(fingerprintSeed),
    deviceId: created.deviceId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  let pushTokenRegistered = false;
  if (input.pushToken?.trim()) {
    await registerDevicePushToken({
      userId: created.userId,
      token: input.pushToken.trim(),
      platform: input.pushPlatform ?? "android",
      deviceId: created.deviceId,
      channelId: HEADS_UP_CHANNEL_ID,
    });
    pushTokenRegistered = true;
  }

  const identity = await getDashboardIdentity(created.userId);
  const { token } = await createSession({
    userId: created.userId,
    deviceId: created.deviceId,
    kind: "ambient_enroll",
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    success: true as const,
    enrolled: true as const,
    matched: true as const,
    user: { id: created.userId, trustId: created.trustId },
    device: {
      id: created.deviceId,
      isMasterDevice: true as const,
      masterDeviceId: master.masterDeviceId,
      deviceFingerprint: fingerprintSeed,
      pushTokenRegistered,
    },
    trustId: created.trustId,
    isMasterDevice: true as const,
    identity,
    sessionToken: token,
    token,
  };
}

/**
 * Re-bind / refresh Master Device + optional FCM token for an existing account.
 */
export async function bindMasterDeviceForUser(input: {
  userId: string;
  deviceId?: string;
  deviceFingerprint: string;
  deviceName?: string;
  pushToken?: string;
  pushPlatform?: string;
  ip?: string;
  userAgent?: string;
}) {
  await prisma.masterDevice.updateMany({
    where: { userId: input.userId, isMasterDevice: true },
    data: { isMasterDevice: false, status: "superseded" },
  });

  let deviceId = input.deviceId;
  if (!deviceId) {
    const primary = await prisma.device.findFirst({
      where: {
        userId: input.userId,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
        status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
      },
    });
    deviceId = primary?.id;
  }

  if (deviceId && input.deviceName) {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        name: input.deviceName.slice(0, 120),
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
        status: DEVICE_STATUS.ACTIVE,
        lastActiveAt: new Date(),
      },
    });
  }

  const master = await registerMasterDevice({
    userId: input.userId,
    deviceFingerprint: input.deviceFingerprint,
    publicKey: placeholderMasterPublicKey(input.deviceFingerprint),
    deviceId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  if (input.pushToken?.trim()) {
    await registerDevicePushToken({
      userId: input.userId,
      token: input.pushToken.trim(),
      platform: input.pushPlatform ?? "android",
      deviceId: deviceId ?? null,
      channelId: HEADS_UP_CHANNEL_ID,
    });
  }

  return {
    success: true as const,
    masterDeviceId: master.masterDeviceId,
    deviceId: deviceId ?? null,
    isMasterDevice: true as const,
  };
}

/** Re-issue a session for a returning install after local fingerprint/PIN unlock. */
export async function unlockSessionForBoundInstall(input: {
  installId: string;
  ip?: string;
  userAgent?: string;
}) {
  const { getInstallOccupancy } = await import(
    "../authentication/device-install.js"
  );
  const occ = await getInstallOccupancy(input.installId);
  if (!occ.occupied || !occ.userId) {
    throw Object.assign(
      new Error("This device is not bound to a Trust ID"),
      { statusCode: 404, code: "install_unbound" },
    );
  }

  const primary = await prisma.device.findFirst({
    where: {
      userId: occ.userId,
      trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
    },
    orderBy: { trustedAt: "asc" },
  });

  const identity = await getDashboardIdentity(occ.userId);
  const { token } = await createSession({
    userId: occ.userId,
    deviceId: primary?.id ?? null,
    kind: "fingerprint_fallback",
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    matched: true as const,
    authenticatedVia: "FINGERPRINT_FALLBACK" as const,
    trustId: occ.trustId,
    identity,
    sessionToken: token,
    token,
    isMasterDevice: true as const,
  };
}
