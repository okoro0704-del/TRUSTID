import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";

export type HeadsUpApprovalPushInput = {
  userId: string;
  requestId: string;
  correlationId: string;
  deviceName: string;
  ipAddress?: string | null;
  deepLink?: string;
};

/**
 * Persist / refresh an FCM or Web Push token for a signed-in user.
 */
export async function registerDevicePushToken(input: {
  userId: string;
  token: string;
  platform?: string;
  deviceId?: string | null;
  channelId?: string;
}) {
  const token = input.token.trim();
  if (token.length < 20) {
    throw Object.assign(new Error("Invalid push token"), { statusCode: 400 });
  }
  const row = await prisma.devicePushToken.upsert({
    where: { token },
    create: {
      userId: input.userId,
      token,
      platform: input.platform ?? "android",
      deviceId: input.deviceId ?? null,
      channelId: input.channelId ?? "high_importance_approval_channel",
      status: "active",
    },
    update: {
      userId: input.userId,
      platform: input.platform ?? "android",
      deviceId: input.deviceId ?? undefined,
      channelId: input.channelId ?? "high_importance_approval_channel",
      status: "active",
    },
  });
  return { id: row.id, platform: row.platform };
}

/**
 * Send a heads-up approval notification via FCM HTTP legacy API when configured.
 * Falls back to no-op when FCM_SERVER_KEY is unset (ElfCom / WS still used).
 */
export async function sendMasterApprovalHeadsUpPush(
  input: HeadsUpApprovalPushInput,
): Promise<{ sent: number; skipped: boolean; error?: string }> {
  const serverKey = process.env.FCM_SERVER_KEY?.trim();
  const tokens = await prisma.devicePushToken.findMany({
    where: { userId: input.userId, status: "active" },
    take: 10,
  });
  if (!tokens.length) {
    return { sent: 0, skipped: true, error: "no_push_tokens" };
  }
  if (!serverKey) {
    return { sent: 0, skipped: true, error: "fcm_unconfigured" };
  }

  const title = "Login Approval Request";
  const body = `${input.deviceName} is requesting account access. Tap to approve.`;
  const deepLink =
    input.deepLink ??
    `${config.webauthn.origin}/dashboard/approvals?requestId=${input.requestId}&correlationId=${input.correlationId}`;

  let sent = 0;
  let lastError: string | undefined;

  for (const row of tokens) {
    try {
      const res = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          Authorization: `key=${serverKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: row.token,
          priority: "high",
          content_available: true,
          notification: {
            title,
            body,
            sound: "default",
            click_action: "OPEN_APPROVAL_MODAL",
            tag: input.requestId,
          },
          android: {
            priority: "high",
            notification: {
              channel_id: row.channelId || "high_importance_approval_channel",
              priority: "max",
              default_sound: true,
              default_vibrate_timings: true,
              visibility: "public",
              notification_priority: "PRIORITY_MAX",
            },
          },
          data: {
            type: "DEVICE_APPROVAL_REQUEST",
            requestId: input.requestId,
            correlationId: input.correlationId,
            deviceMeta: input.deviceName,
            ipAddress: input.ipAddress ?? "",
            deepLink,
            timestamp: String(Math.floor(Date.now() / 1000)),
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        lastError = await res.text().catch(() => `fcm_${res.status}`);
        continue;
      }
      sent += 1;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "fcm_send_failed";
    }
  }

  return { sent, skipped: sent === 0, error: lastError };
}
