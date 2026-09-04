/**
 * TrustID ? ElfCom Universal Push Primitive adapter.
 * Master Device approval alerts go through POST /v1/baas/notify (never direct FCM).
 */
import { getElfComClient } from "../baas/registry.js";
import { config } from "../../lib/config.js";

export type MasterApprovalPushInput = {
  targetTrustId: string;
  challengeId: string;
  deviceLabel: string;
  locationHint?: string;
  correlationId?: string;
  deepLink?: string;
};

/**
 * Dispatches high-priority Master Device approval alerts via ElfCom BaaS notify.
 */
export async function sendMasterDeviceApprovalPush(input: MasterApprovalPushInput) {
  if (!config.elfcom.baasApiKey) {
    throw new Error("ELFCOM_BAAS_API_KEY is not defined in environment variables.");
  }

  const client = getElfComClient();
  if (!client.bound) {
    throw new Error("ElfCom client is unbound (set ELFCOM_MODE=http).");
  }

  const deepLink =
    input.deepLink ?? `trustid://approvals/${input.challengeId}`;
  const body = `Approve sign-in on ${input.deviceLabel}${
    input.locationHint ? ` · ${input.locationHint}` : ""
  }`;

  const result = await client.notify({
    targetTrustId: input.targetTrustId,
    title: "Master Device Approval Required",
    body,
    priority: "MAX",
    channelId: "trust_id_security_alerts",
    dataPayload: {
      type: "master_device_approval",
      challengeId: input.challengeId,
      correlationId: input.correlationId ?? input.challengeId,
      deepLink,
    },
  });

  if (!result.ok) {
    throw new Error(
      `Failed to dispatch push via ElfCom: ${result.statusCode ?? "?"} - ${result.error ?? "unknown"}`,
    );
  }

  return result.data ?? { ok: true };
}
