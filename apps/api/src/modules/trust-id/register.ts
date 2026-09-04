import { createHash } from "node:crypto";
import { DEVICE_STATUS, DEVICE_TRUST_LEVELS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { registerDevicePushToken } from "../notifications/push.js";
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
 * optionally store an FCM/WebPush token, and issue a session.
 */
export async function registerTrustIdWithMasterDevice(input: {
  payload: MultiModalPayload;
  installId?: string;
  deviceName?: string;
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
    payload: input.payload,
    installId: input.installId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  if (input.deviceName) {
    await prisma.device.update({
      where: { id: created.deviceId },
      data: {
        name: input.deviceName.slice(0, 120),
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
        status: DEVICE_STATUS.ACTIVE,
      },
    });
  }

  const fingerprintSeed =
    input.payload.deviceFingerprint ||
    face?.deviceFingerprint ||
    input.installId ||
    created.deviceId;

  const master = await registerMasterDevice({
    userId: created.userId,
    deviceFingerprint: fingerprintSeed,
    publicKey: placeholderMasterPublicKey(fingerprintSeed),
    deviceId: created.deviceId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  if (input.pushToken?.trim()) {
    await registerDevicePushToken({
      userId: created.userId,
      token: input.pushToken.trim(),
      platform: input.pushPlatform ?? "android",
      deviceId: created.deviceId,
    });
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
    },
    trustId: created.trustId,
    isMasterDevice: true as const,
    identity,
    sessionToken: token,
    token,
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
