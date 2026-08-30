import {
  AUDIT_EVENTS,
  DEVICE_APPROVAL_STATUS,
  isDeviceApprovalActive,
  isDeviceApprovalTerminal,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";
import { broadcastApprovalEvent } from "../realtime/hub.js";

export type ApprovalFsmState =
  | typeof DEVICE_APPROVAL_STATUS.PENDING
  | typeof DEVICE_APPROVAL_STATUS.PUSHED
  | typeof DEVICE_APPROVAL_STATUS.VIEWED
  | typeof DEVICE_APPROVAL_STATUS.APPROVED
  | typeof DEVICE_APPROVAL_STATUS.TEMPORARY
  | typeof DEVICE_APPROVAL_STATUS.DECLINED
  | typeof DEVICE_APPROVAL_STATUS.EXPIRED;

export type ApprovalFsmEvent =
  | "created"
  | "push_dispatched"
  | "push_failed"
  | "viewed"
  | "approved"
  | "temporary_granted"
  | "denied"
  | "expired";

const TRANSITIONS: Record<
  string,
  Partial<Record<ApprovalFsmEvent, ApprovalFsmState>>
> = {
  [DEVICE_APPROVAL_STATUS.PENDING]: {
    push_dispatched: DEVICE_APPROVAL_STATUS.PUSHED,
    push_failed: DEVICE_APPROVAL_STATUS.PENDING,
    viewed: DEVICE_APPROVAL_STATUS.VIEWED,
    approved: DEVICE_APPROVAL_STATUS.APPROVED,
    temporary_granted: DEVICE_APPROVAL_STATUS.TEMPORARY,
    denied: DEVICE_APPROVAL_STATUS.DECLINED,
    expired: DEVICE_APPROVAL_STATUS.EXPIRED,
  },
  [DEVICE_APPROVAL_STATUS.PUSHED]: {
    viewed: DEVICE_APPROVAL_STATUS.VIEWED,
    approved: DEVICE_APPROVAL_STATUS.APPROVED,
    temporary_granted: DEVICE_APPROVAL_STATUS.TEMPORARY,
    denied: DEVICE_APPROVAL_STATUS.DECLINED,
    expired: DEVICE_APPROVAL_STATUS.EXPIRED,
  },
  [DEVICE_APPROVAL_STATUS.VIEWED]: {
    approved: DEVICE_APPROVAL_STATUS.APPROVED,
    temporary_granted: DEVICE_APPROVAL_STATUS.TEMPORARY,
    denied: DEVICE_APPROVAL_STATUS.DECLINED,
    expired: DEVICE_APPROVAL_STATUS.EXPIRED,
  },
};

export function nextApprovalState(
  current: string,
  event: ApprovalFsmEvent,
): ApprovalFsmState | null {
  if (isDeviceApprovalTerminal(current)) return null;
  return TRANSITIONS[current]?.[event] ?? null;
}

export type ApprovalRow = {
  id: string;
  userId: string;
  status: string;
  correlationId: string;
  pollTokenHash: string;
  expiresAt: Date;
  applicationName: string | null;
  requestedDeviceName: string;
  platform: string | null;
  browser: string | null;
  location: string | null;
  ip: string | null;
  userAgent: string | null;
  clientId: string | null;
  oauthConsentCodeId: string | null;
  guestSessionId: string | null;
  pushDispatchedAt: Date | null;
  pushFailedAt: Date | null;
  viewedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

export function toApprovalEventPayload(row: ApprovalRow) {
  return {
    correlationId: row.correlationId,
    requestId: row.id,
    status: row.status,
    applicationName: row.applicationName ?? "TrustID",
    deviceName: row.requestedDeviceName,
    platform: row.platform,
    browser: row.browser,
    location: row.location,
    clientId: row.clientId,
    oauthConsentCodeId: row.oauthConsentCodeId,
    guestSessionId: row.guestSessionId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    viewedAt: row.viewedAt?.toISOString() ?? null,
    pushDispatchedAt: row.pushDispatchedAt?.toISOString() ?? null,
    pushFailedAt: row.pushFailedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export async function transitionApprovalFsm(input: {
  row: ApprovalRow;
  event: ApprovalFsmEvent;
  audit?: {
    type: string;
    actorType?: string;
    actorId?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  };
  extraData?: Record<string, unknown>;
}): Promise<ApprovalRow> {
  const next = nextApprovalState(input.row.status, input.event);
  if (!next && input.event !== "push_failed") {
    throw Object.assign(
      new Error(`Invalid FSM transition: ${input.row.status} + ${input.event}`),
      { statusCode: 409 },
    );
  }

  const now = new Date();
  const data: Record<string, unknown> = { ...(input.extraData ?? {}) };

  if (input.event === "push_dispatched") {
    data.status = DEVICE_APPROVAL_STATUS.PUSHED;
    data.pushDispatchedAt = now;
    data.pushFailedAt = null;
  } else if (input.event === "push_failed") {
    data.pushFailedAt = now;
  } else if (input.event === "viewed") {
    data.status = DEVICE_APPROVAL_STATUS.VIEWED;
    data.viewedAt = now;
  } else if (input.event === "approved") {
    data.status = DEVICE_APPROVAL_STATUS.APPROVED;
    data.resolvedAt = now;
  } else if (input.event === "temporary_granted") {
    data.status = DEVICE_APPROVAL_STATUS.TEMPORARY;
    data.resolvedAt = now;
  } else if (input.event === "denied") {
    data.status = DEVICE_APPROVAL_STATUS.DECLINED;
    data.resolvedAt = now;
  } else if (input.event === "expired") {
    data.status = DEVICE_APPROVAL_STATUS.EXPIRED;
    data.resolvedAt = now;
  } else if (next) {
    data.status = next;
  }

  const updated = await prisma.deviceApprovalRequest.update({
    where: { id: input.row.id },
    data,
  });

  if (input.audit) {
    const actorType =
      input.audit.actorType === "user" ||
      input.audit.actorType === "application" ||
      input.audit.actorType === "system"
        ? input.audit.actorType
        : ("system" as const);
    await recordAudit({
      type: input.audit.type,
      userId: input.row.userId,
      actorType,
      actorId: input.audit.actorId ?? null,
      metadata: {
        requestId: input.row.id,
        correlationId: input.row.correlationId,
        from: input.row.status,
        to: updated.status,
        event: input.event,
        ...(input.audit.metadata ?? {}),
      },
      ip: input.audit.ip,
      userAgent: input.audit.userAgent,
    });
  }

  const payload = toApprovalEventPayload(updated as ApprovalRow);
  const messageType = isDeviceApprovalTerminal(updated.status)
    ? "approval.resolved"
    : input.event === "created"
      ? "approval.created"
      : "approval.state";

  broadcastApprovalEvent({
    userId: input.row.userId,
    pollTokenHash: input.row.pollTokenHash,
    message: {
      type: messageType,
      ...payload,
      at: now.toISOString(),
    },
  });

  return updated as ApprovalRow;
}

export async function expireApprovalIfNeeded(row: ApprovalRow): Promise<boolean> {
  if (!isDeviceApprovalActive(row.status)) return false;
  if (row.expiresAt.getTime() >= Date.now()) return false;

  await transitionApprovalFsm({
    row,
    event: "expired",
    audit: { type: AUDIT_EVENTS.DEVICE_APPROVAL_EXPIRED },
  });
  return true;
}
