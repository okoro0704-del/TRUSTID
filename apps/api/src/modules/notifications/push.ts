import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { getElfComClient } from "../baas/registry.js";
import { mintElfComCapabilityJwt } from "../elfcom/capability.js";
import { sendMasterDeviceApprovalPush } from "../elfcom/push.adapter.js";

/** Primary Android channel ù IMPORTANCE_HIGH heads-up banner */
export const HEADS_UP_CHANNEL_ID = "trust_id_security_alerts";
/** Legacy channel kept for older installs */
export const HEADS_UP_CHANNEL_LEGACY = "high_importance_approval_channel";

export type HeadsUpApprovalPushInput = {
  userId: string;
  requestId: string;
  correlationId: string;
  deviceName: string;
  ipAddress?: string | null;
  deepLink?: string;
  ownerTrustId?: string;
  locationHint?: string | null;
};

/**
 * Register push token with ElfCom Universal Push Primitive (POST /v1/devices/register).
 * Local DevicePushToken remains a legacy mirror until ElfCom is sole directory.
 */
export async function registerDevicePushToken(input: {
  userId: string;
  token: string;
  platform?: string;
  deviceId?: string | null;
  channelId?: string;
  ownerTrustId?: string;
}) {
  const token = input.token.trim();
  if (token.length < 20) {
    throw Object.assign(new Error("Invalid push token"), { statusCode: 400 });
  }
  const channelId = input.channelId ?? HEADS_UP_CHANNEL_ID;

  const elfcom = getElfComClient();
  let via: "elfcom" | "local_fallback" = "local_fallback";

  if (elfcom.bound && input.ownerTrustId) {
    try {
      const bearerToken = await mintElfComCapabilityJwt({
        trustId: input.ownerTrustId,
      });
      const remote = await elfcom.registerPushToken({
        ownerTrustId: input.ownerTrustId,
        token,
        platform: input.platform ?? "android",
        deviceId: input.deviceId ?? null,
        channelId,
        bearerToken,
        appId: config.elfcom.appId,
      });
      if (remote.ok) via = "elfcom";
      else {
        console.warn(
          "[push] ElfCom device register failed:",
          remote.error ?? remote.statusCode,
        );
      }
    } catch (err) {
      console.warn(
        "[push] ElfCom device register error:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const row = await prisma.devicePushToken.upsert({
    where: { token },
    create: {
      userId: input.userId,
      token,
      platform: input.platform ?? "android",
      deviceId: input.deviceId ?? null,
      channelId,
      status: "active",
    },
    update: {
      userId: input.userId,
      platform: input.platform ?? "android",
      deviceId: input.deviceId ?? undefined,
      channelId,
      status: "active",
    },
  });
  return {
    id: row.id,
    platform: row.platform,
    channelId: row.channelId,
    via,
  };
}

/**
 * OS heads-up for master approval ù delivered via ElfCom /v1/baas/notify only.
 */
export async function sendMasterApprovalHeadsUpPush(
  input: HeadsUpApprovalPushInput,
): Promise<{ sent: number; skipped: boolean; error?: string; via: string }> {
  const elfcom = getElfComClient();
  const deepLink =
    input.deepLink ??
    `${config.webauthn.origin}/dashboard/approvals?requestId=${input.requestId}&correlationId=${input.correlationId}`;

  if (!elfcom.bound) {
    return { sent: 0, skipped: true, error: "elfcom_unbound", via: "unbound" };
  }

  let ownerTrustId = input.ownerTrustId;
  if (!ownerTrustId) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { trustId: true },
    });
    ownerTrustId = user?.trustId;
  }
  if (!ownerTrustId) {
    return { sent: 0, skipped: true, error: "missing_trust_id", via: "elfcom" };
  }

  try {
    await sendMasterDeviceApprovalPush({
      targetTrustId: ownerTrustId,
      challengeId: input.requestId,
      deviceLabel: input.deviceName,
      locationHint: input.locationHint ?? input.ipAddress ?? undefined,
      correlationId: input.correlationId,
      deepLink,
    });
    return { sent: 1, skipped: false, via: "elfcom" };
  } catch (err) {
    return {
      sent: 0,
      skipped: true,
      error: err instanceof Error ? err.message : "elfcom_notify_failed",
      via: "elfcom",
    };
  }
}

/** Prefer sendMasterApprovalHeadsUpPush; adapter re-export for callers. */
export { sendMasterDeviceApprovalPush };
