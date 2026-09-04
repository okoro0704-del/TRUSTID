import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { getElfComClient } from "../baas/registry.js";

/** Primary Android channel — IMPORTANCE_HIGH heads-up banner */
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
};

/**
 * Register push token with ElfCom (preferred). Local DevicePushToken is legacy fallback
 * until ElfCom device directory is authoritative.
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
  if (elfcom.bound && input.ownerTrustId) {
    await elfcom.registerPushToken({
      ownerTrustId: input.ownerTrustId,
      token,
      platform: input.platform ?? "android",
      deviceId: input.deviceId ?? null,
      channelId,
    });
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
    via: elfcom.bound ? ("elfcom" as const) : ("local_fallback" as const),
  };
}

/**
 * OS heads-up for master approval — delivered via ElfCom only.
 * Direct FCM from TrustID is removed (monolith leakage).
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

  const result = await elfcom.pushConsent({
    correlationId: input.correlationId,
    requestId: input.requestId,
    ownerTrustId,
    title: "Login Approval Requested",
    body: `New login attempt from ${input.deviceName}. Tap to approve or decline.`,
    silent: false,
    deepLink,
    metadata: {
      type: "MASTER_APPROVAL_REQUEST",
      requestId: input.requestId,
      deviceMeta: input.deviceName,
      ipAddress: input.ipAddress ?? "",
      channelId: HEADS_UP_CHANNEL_ID,
      priority: "high",
      click_action: "OPEN_APPROVAL_MODAL",
      timestamp: String(Math.floor(Date.now() / 1000)),
    },
  });

  if (!result.ok) {
    return { sent: 0, skipped: true, error: result.error, via: "elfcom" };
  }
  return { sent: 1, skipped: false, via: "elfcom" };
}

/** @deprecated alias */
export const sendMasterDeviceApprovalPush = sendMasterApprovalHeadsUpPush;
