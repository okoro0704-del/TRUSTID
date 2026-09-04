import {
  AUDIT_EVENTS,
  DEVICE_APPROVAL_STATUS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  SESSION_KINDS,
  isDeviceApprovalActive,
} from "@trustid/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { hashSecret, randomToken } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { findUserByContact } from "../authentication/service.js";
import { verifyReauthentication } from "../authentication/webauthn.js";
import { createSession } from "../sessions/service.js";
import { createSecurityNotification } from "../notifications/service.js";
import { assertPrimaryDevice } from "../devices/trust.js";
import { getElfComConsentDispatcher } from "../elfcom/index.js";
import { broadcastApprovalEvent } from "../realtime/hub.js";
import {
  expireApprovalIfNeeded,
  toApprovalEventPayload,
  transitionApprovalFsm,
  type ApprovalRow,
} from "./fsm.js";

async function confirmMasterAction(input: {
  userId: string;
  deviceId: string | null | undefined;
  response?: AuthenticationResponseJSON | null;
  ip?: string;
  userAgent?: string;
}) {
  await assertPrimaryDevice(input.userId, input.deviceId);
  if (input.response) {
    await verifyReauthentication({
      userId: input.userId,
      deviceId: input.deviceId ?? undefined,
      response: input.response,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return;
  }

  // Face-first masters often have no passkey yet — allow primary-session confirm.
  const passkeys = await prisma.credential.count({
    where: {
      userId: input.userId,
      status: { not: DEVICE_STATUS.REVOKED },
    },
  });
  if (passkeys === 0) return;

  throw Object.assign(
    new Error("Biometric / passkey confirmation required"),
    { statusCode: 400 },
  );
}

function guessBrowser(ua: string | null | undefined) {
  if (!ua) return null;
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  return "Browser";
}

function guessPlatform(ua: string | null | undefined) {
  if (!ua) return null;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS|Macintosh/i.test(ua)) return "macOS";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iOS/i.test(ua)) return "iOS";
  if (/Linux/i.test(ua)) return "Linux";
  return null;
}

async function markExpiredIfNeeded(row: ApprovalRow) {
  return expireApprovalIfNeeded(row);
}

async function dispatchConsentPush(row: ApprovalRow, userTrustId: string) {
  const dispatcher = getElfComConsentDispatcher();
  const deepLink = `${config.webauthn.origin}/dashboard/approvals?requestId=${row.id}&correlationId=${row.correlationId}`;

  // OS heads-up via FCM when tokens + FCM_SERVER_KEY are configured.
  try {
    const { sendMasterApprovalHeadsUpPush } = await import(
      "../notifications/push.js"
    );
    await sendMasterApprovalHeadsUpPush({
      userId: row.userId,
      requestId: row.id,
      correlationId: row.correlationId,
      deviceName: row.requestedDeviceName,
      ipAddress: row.ip,
      deepLink,
    });
  } catch {
    /* FCM optional — ElfCom / WS still notify */
  }

  const result = await dispatcher.pushConsent({
    correlationId: row.correlationId,
    requestId: row.id,
    ownerTrustId: userTrustId,
    title: "Login Approval Requested",
    body: `New login attempt from ${row.requestedDeviceName}. Tap to approve or decline.`,
    silent: false,
    deepLink,
    metadata: {
      type: "MASTER_APPROVAL_REQUEST",
      requestId: row.id,
      deviceMeta: row.requestedDeviceName,
      ipAddress: row.ip,
      timestamp: String(Math.floor(Date.now() / 1000)),
      click_action: "OPEN_APPROVAL_MODAL",
      priority: "high",
      channelId: "trust_id_security_alerts",
      applicationName: row.applicationName,
      platform: row.platform,
      browser: row.browser,
      location: row.location,
      clientId: row.clientId,
      oauthConsentCodeId: row.oauthConsentCodeId,
      guestSessionId: row.guestSessionId,
    },
  });

  if (result.ok) {
    await transitionApprovalFsm({
      row,
      event: "push_dispatched",
      audit: {
        type: AUDIT_EVENTS.DEVICE_APPROVAL_PUSHED,
        actorType: "system",
        metadata: { via: "elfcom" },
      },
    });
  } else {
    await transitionApprovalFsm({
      row,
      event: "push_failed",
      audit: {
        type: AUDIT_EVENTS.DEVICE_APPROVAL_REQUESTED,
        actorType: "system",
        metadata: { pushError: result.error ?? "unknown" },
      },
    });
  }
}

export async function createDeviceApprovalRequest(input: {
  email?: string;
  phone?: string;
  trustId?: string;
  deviceName?: string;
  clientId?: string;
  applicationName?: string;
  location?: string;
  ip?: string;
  userAgent?: string;
  oauthConsentCodeId?: string;
  guestSessionId?: string;
}) {
  const user =
    (await findUserByContact(input.email, input.phone)) ||
    (input.trustId
      ? await (await import("../authentication/service.js")).findUserByTrustId(
          input.trustId,
        )
      : null);
  if (!user) {
    throw Object.assign(new Error("No account found for that contact"), {
      statusCode: 404,
    });
  }

  const primaryCount = await prisma.device.count({
    where: {
      userId: user.id,
      trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
    },
  });
  if (primaryCount < 1) {
    throw Object.assign(
      new Error("No primary trusted device available to approve this request"),
      { statusCode: 400 },
    );
  }

  let applicationId: string | null = null;
  let applicationName = input.applicationName ?? null;
  if (input.clientId) {
    const app = await prisma.application.findUnique({
      where: { clientId: input.clientId },
    });
    if (app) {
      applicationId = app.id;
      applicationName = applicationName ?? app.name;
    }
  }

  const pollToken = randomToken(24);
  // Auto-expire pending login attempts quickly (default 180s).
  const ttlMs = Math.max(
    60_000,
    Number(process.env.DEVICE_APPROVAL_TTL_SECONDS ?? 180) * 1000,
  );
  const expiresAt = new Date(Date.now() + ttlMs);
  const deviceName =
    input.deviceName?.trim() ||
    guessBrowser(input.userAgent) ||
    "Unknown device";

  const request = await prisma.deviceApprovalRequest.create({
    data: {
      userId: user.id,
      applicationId,
      clientId: input.clientId ?? null,
      applicationName,
      requestedDeviceName: deviceName,
      platform: guessPlatform(input.userAgent),
      browser: guessBrowser(input.userAgent),
      location: input.location ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      status: DEVICE_APPROVAL_STATUS.PENDING,
      pollTokenHash: hashSecret(pollToken),
      oauthConsentCodeId: input.oauthConsentCodeId ?? null,
      guestSessionId: input.guestSessionId ?? null,
      expiresAt,
    },
  });

  const row = request as ApprovalRow;

  broadcastApprovalEvent({
    userId: user.id,
    pollTokenHash: row.pollTokenHash,
    message: {
      type: "approval.created",
      ...toApprovalEventPayload(row),
      at: new Date().toISOString(),
    },
  });

  // High-priority aliases for Master Device notification receivers.
  broadcastApprovalEvent({
    userId: user.id,
    pollTokenHash: row.pollTokenHash,
    message: {
      type: "DEVICE_APPROVAL_REQUEST",
      ...toApprovalEventPayload(row),
      at: new Date().toISOString(),
    },
  });
  broadcastApprovalEvent({
    userId: user.id,
    pollTokenHash: row.pollTokenHash,
    message: {
      type: "MASTER_APPROVAL_REQUEST",
      ...toApprovalEventPayload(row),
      at: new Date().toISOString(),
    },
  });

  await dispatchConsentPush(row, user.trustId);

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_APPROVAL_REQUESTED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: {
      requestId: request.id,
      applicationName,
      deviceName,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await createSecurityNotification({
    userId: user.id,
    type: "device_approval_request",
    title: "New device wants access",
    body: `${applicationName ?? "TrustID"}: ${deviceName} (${guessBrowser(input.userAgent) ?? "browser"} on ${guessPlatform(input.userAgent) ?? "unknown"})`,
    payload: {
      requestId: request.id,
      applicationName,
      deviceName,
      browser: guessBrowser(input.userAgent),
      platform: guessPlatform(input.userAgent),
      location: input.location ?? null,
      createdAt: request.createdAt.toISOString(),
    },
  });

  return {
    requestId: request.id,
    correlationId: request.correlationId,
    pollToken,
    status: request.status,
    expiresAt: expiresAt.toISOString(),
    message: "Waiting for approval from one of your trusted devices...",
  };
}

export async function getApprovalStatusByPollToken(pollToken: string) {
  const row = await prisma.deviceApprovalRequest.findUnique({
    where: { pollTokenHash: hashSecret(pollToken) },
  });
  if (!row) {
    throw Object.assign(new Error("Approval request not found"), {
      statusCode: 404,
    });
  }
  if (await markExpiredIfNeeded(row)) {
    return {
      requestId: row.id,
      status: DEVICE_APPROVAL_STATUS.EXPIRED,
      message: "This approval request has expired.",
    };
  }
  return {
    requestId: row.id,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    applicationName: row.applicationName,
    deviceName: row.requestedDeviceName,
    message:
      isDeviceApprovalActive(row.status)
        ? "Waiting for approval from one of your trusted devices..."
        : row.status === DEVICE_APPROVAL_STATUS.DECLINED
          ? "Access was denied from a trusted device."
          : undefined,
  };
}

export async function claimApprovalResult(pollToken: string) {
  const row = await prisma.deviceApprovalRequest.findUnique({
    where: { pollTokenHash: hashSecret(pollToken) },
  });
  if (!row) {
    throw Object.assign(new Error("Approval request not found"), {
      statusCode: 404,
    });
  }
  if (await markExpiredIfNeeded(row)) {
    throw Object.assign(new Error("Approval request expired"), {
      statusCode: 400,
    });
  }
  if (row.claimConsumedAt) {
    throw Object.assign(new Error("Approval result already claimed"), {
      statusCode: 400,
    });
  }

  if (row.status === DEVICE_APPROVAL_STATUS.APPROVED) {
    // Identity-first: grant a session on this terminal without creating another passkey.
    const device = await prisma.device.create({
      data: {
        userId: row.userId,
        name: row.requestedDeviceName,
        status: DEVICE_STATUS.ACTIVE,
        trustLevel: DEVICE_TRUST_LEVELS.STANDARD,
        platform: row.platform,
        userAgent: row.userAgent,
        lastIp: row.ip,
        lastActiveAt: new Date(),
        trustedAt: new Date(),
      },
    });

    // TRUST once: bind secondary install so next ambient login skips master approval.
    if (row.guestSessionId) {
      try {
        const { bindInstallToUser } = await import(
          "../authentication/device-install.js"
        );
        await bindInstallToUser(row.guestSessionId, row.userId);
      } catch {
        /* invalid / occupied install — session still granted */
      }
    }

    const { session, token } = await createSession({
      userId: row.userId,
      deviceId: device.id,
      applicationId: row.applicationId,
      kind: SESSION_KINDS.STANDARD,
      ip: row.ip ?? undefined,
      userAgent: row.userAgent ?? undefined,
    });
    await prisma.deviceApprovalRequest.update({
      where: { id: row.id },
      data: {
        resultingDeviceId: device.id,
        claimConsumedAt: new Date(),
        enrollmentTokenHash: null,
        enrollmentTokenExpires: null,
      },
    });

    // Notify waiting secondary immediately (alias for clients listening on LOGIN_APPROVAL_RESULT).
    broadcastApprovalEvent({
      userId: row.userId,
      pollTokenHash: row.pollTokenHash,
      message: {
        type: "LOGIN_APPROVAL_RESULT",
        correlationId: row.correlationId,
        requestId: row.id,
        status: "APPROVED_TRUSTED",
        deviceName: row.requestedDeviceName,
        at: new Date().toISOString(),
      },
    });

    return {
      status: DEVICE_APPROVAL_STATUS.APPROVED,
      mode: "ambient" as const,
      sessionToken: token,
      sessionId: session.id,
      requestId: row.id,
      userId: row.userId,
      deviceId: device.id,
      offerSaveDeviceKey: true,
    };
  }

  if (row.status === DEVICE_APPROVAL_STATUS.TEMPORARY) {
    if (!row.resultingDeviceId) {
      throw Object.assign(new Error("Temporary device missing"), {
        statusCode: 400,
      });
    }
    const device = await prisma.device.findUnique({
      where: { id: row.resultingDeviceId },
    });
    if (!device || device.status === "revoked") {
      throw Object.assign(new Error("Temporary device unavailable"), {
        statusCode: 400,
      });
    }
    const expiresAt =
      device.expiresAt ??
      new Date(Date.now() + config.temporarySessionHours * 60 * 60 * 1000);
    const { session, token } = await createSession({
      userId: row.userId,
      deviceId: device.id,
      applicationId: row.applicationId,
      kind: SESSION_KINDS.TEMPORARY,
      expiresAt,
      ip: row.ip,
      userAgent: row.userAgent,
    });
    await prisma.deviceApprovalRequest.update({
      where: { id: row.id },
      data: {
        oneTimeSessionTokenHash: hashSecret(token),
        claimConsumedAt: new Date(),
      },
    });

    broadcastApprovalEvent({
      userId: row.userId,
      pollTokenHash: row.pollTokenHash,
      message: {
        type: "LOGIN_APPROVAL_RESULT",
        correlationId: row.correlationId,
        requestId: row.id,
        status: "APPROVED_TEMPORARY",
        deviceName: row.requestedDeviceName,
        at: new Date().toISOString(),
      },
    });

    return {
      status: DEVICE_APPROVAL_STATUS.TEMPORARY,
      mode: "temporary" as const,
      sessionToken: token,
      sessionId: session.id,
      requestId: row.id,
      userId: row.userId,
      deviceId: row.resultingDeviceId,
    };
  }

  if (row.status === DEVICE_APPROVAL_STATUS.DECLINED) {
    throw Object.assign(new Error("Access was denied"), { statusCode: 403 });
  }

  throw Object.assign(new Error("Approval is still pending"), {
    statusCode: 400,
  });
}

export async function listPendingApprovals(userId: string) {
  await expireStaleForUser(userId);
  const rows = await prisma.deviceApprovalRequest.findMany({
    where: {
      userId,
      status: {
        in: [
          DEVICE_APPROVAL_STATUS.PENDING,
          DEVICE_APPROVAL_STATUS.PUSHED,
          DEVICE_APPROVAL_STATUS.VIEWED,
        ],
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(publicApproval);
}

export async function listApprovals(userId: string, limit = 30) {
  await expireStaleForUser(userId);
  const rows = await prisma.deviceApprovalRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(publicApproval);
}

function publicApproval(r: {
  id: string;
  correlationId?: string;
  status: string;
  applicationName: string | null;
  requestedDeviceName: string;
  platform: string | null;
  browser: string | null;
  location: string | null;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  pushDispatchedAt?: Date | null;
  pushFailedAt?: Date | null;
  viewedAt?: Date | null;
}) {
  return {
    id: r.id,
    correlationId: r.correlationId,
    status: r.status,
    applicationName: r.applicationName ?? "TrustID",
    deviceName: r.requestedDeviceName,
    platform: r.platform,
    browser: r.browser,
    location: r.location,
    ip: r.ip,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    pushDispatchedAt: r.pushDispatchedAt?.toISOString() ?? null,
    pushFailedAt: r.pushFailedAt?.toISOString() ?? null,
    viewedAt: r.viewedAt?.toISOString() ?? null,
  };
}

async function expireStaleForUser(userId: string) {
  const stale = await prisma.deviceApprovalRequest.findMany({
    where: {
      userId,
      status: {
        in: [
          DEVICE_APPROVAL_STATUS.PENDING,
          DEVICE_APPROVAL_STATUS.PUSHED,
          DEVICE_APPROVAL_STATUS.VIEWED,
        ],
      },
      expiresAt: { lt: new Date() },
    },
  });
  for (const row of stale) {
    await markExpiredIfNeeded(row as ApprovalRow);
  }
}

async function loadActiveForPrimary(
  userId: string,
  requestId: string,
  deviceId: string | null | undefined,
) {
  await assertPrimaryDevice(userId, deviceId);
  const row = await prisma.deviceApprovalRequest.findFirst({
    where: { id: requestId, userId },
  });
  if (!row) {
    throw Object.assign(new Error("Approval request not found"), {
      statusCode: 404,
    });
  }
  if (await markExpiredIfNeeded(row as ApprovalRow)) {
    throw Object.assign(new Error("Approval request expired"), {
      statusCode: 400,
    });
  }
  if (!isDeviceApprovalActive(row.status)) {
    throw Object.assign(new Error("Request already resolved"), {
      statusCode: 400,
    });
  }
  return row as ApprovalRow;
}

export async function markApprovalViewed(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
}) {
  const row = await loadActiveForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  if (row.status === DEVICE_APPROVAL_STATUS.VIEWED) {
    return publicApproval(row);
  }
  const updated = await transitionApprovalFsm({
    row,
    event: "viewed",
    audit: {
      type: AUDIT_EVENTS.DEVICE_APPROVAL_VIEWED,
      actorType: "user",
      actorId: input.userId,
    },
  });
  return publicApproval(updated);
}

export async function approveTrustDevice(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  response?: AuthenticationResponseJSON | null;
  ip?: string;
  userAgent?: string;
}) {
  const row = await loadActiveForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  await confirmMasterAction({
    userId: input.userId,
    deviceId: input.deviceId,
    response: input.response,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const enrollmentToken = randomToken(32);
  const updated = await transitionApprovalFsm({
    row,
    event: "approved",
    extraData: {
      approvedByDeviceId: input.deviceId ?? null,
      enrollmentTokenHash: hashSecret(enrollmentToken),
      enrollmentTokenExpires: new Date(Date.now() + 5 * 60 * 1000),
    },
    audit: {
      type: AUDIT_EVENTS.DEVICE_APPROVAL_APPROVED,
      actorType: "user",
      actorId: input.userId,
      metadata: { mode: "trust" },
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "device_approval_resolved",
    title: "Device trusted",
    body: `${row.requestedDeviceName} was approved as a trusted device.`,
    payload: { requestId: row.id, status: updated.status },
  });

  broadcastApprovalEvent({
    userId: input.userId,
    pollTokenHash: row.pollTokenHash,
    message: {
      type: "LOGIN_APPROVAL_RESULT",
      correlationId: row.correlationId,
      requestId: row.id,
      status: "APPROVED_TRUSTED",
      deviceName: row.requestedDeviceName,
      at: new Date().toISOString(),
    },
  });

  return { id: updated.id, status: updated.status };
}

export async function approveTemporaryAccess(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  response?: AuthenticationResponseJSON | null;
  ip?: string;
  userAgent?: string;
}) {
  const row = await loadActiveForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  await confirmMasterAction({
    userId: input.userId,
    deviceId: input.deviceId,
    response: input.response,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const expiresAt = new Date(
    Date.now() + config.temporarySessionHours * 60 * 60 * 1000,
  );
  const tempDevice = await prisma.device.create({
    data: {
      userId: input.userId,
      name: row.requestedDeviceName,
      status: DEVICE_STATUS.ACTIVE,
      trustLevel: DEVICE_TRUST_LEVELS.TEMPORARY,
      deviceType: row.browser,
      userAgent: row.userAgent,
      platform: row.platform,
      lastIp: row.ip,
      lastLocation: row.location,
      lastActiveAt: new Date(),
      expiresAt,
    },
  });

  const updated = await transitionApprovalFsm({
    row,
    event: "temporary_granted",
    extraData: {
      approvedByDeviceId: input.deviceId ?? null,
      resultingDeviceId: tempDevice.id,
      oneTimeSessionTokenHash: null,
    },
    audit: {
      type: AUDIT_EVENTS.DEVICE_APPROVAL_TEMPORARY,
      actorType: "user",
      actorId: input.userId,
      metadata: {
        deviceId: tempDevice.id,
        expiresAt: expiresAt.toISOString(),
      },
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "device_approval_resolved",
    title: "Temporary access granted",
    body: `${row.requestedDeviceName} may use TrustID until ${expiresAt.toLocaleString()}.`,
    payload: { requestId: row.id, status: updated.status },
  });

  broadcastApprovalEvent({
    userId: input.userId,
    pollTokenHash: row.pollTokenHash,
    message: {
      type: "LOGIN_APPROVAL_RESULT",
      correlationId: row.correlationId,
      requestId: row.id,
      status: "APPROVED_TEMPORARY",
      deviceName: row.requestedDeviceName,
      at: new Date().toISOString(),
    },
  });

  return { id: updated.id, status: updated.status, expiresAt: expiresAt.toISOString() };
}

export async function declineApproval(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  response?: AuthenticationResponseJSON | null;
  ip?: string;
  userAgent?: string;
}) {
  const row = await loadActiveForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  await confirmMasterAction({
    userId: input.userId,
    deviceId: input.deviceId,
    response: input.response,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const updated = await transitionApprovalFsm({
    row,
    event: "denied",
    extraData: {
      approvedByDeviceId: input.deviceId ?? null,
    },
    audit: {
      type: AUDIT_EVENTS.DEVICE_APPROVAL_DECLINED,
      actorType: "user",
      actorId: input.userId,
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "device_approval_resolved",
    title: "Device access declined",
    body: `Access for ${row.requestedDeviceName} was declined.`,
    payload: { requestId: row.id, status: updated.status },
  });

  broadcastApprovalEvent({
    userId: input.userId,
    pollTokenHash: row.pollTokenHash,
    message: {
      type: "LOGIN_APPROVAL_RESULT",
      correlationId: row.correlationId,
      requestId: row.id,
      status: "REJECTED",
      deviceName: row.requestedDeviceName,
      at: new Date().toISOString(),
    },
  });

  return { id: updated.id, status: updated.status };
}

/** Unified master respond endpoint for TRUST | TEMPORARY | DECLINE. */
export async function respondToDeviceApproval(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  action: "TRUST" | "TEMPORARY" | "DECLINE";
  response?: AuthenticationResponseJSON | null;
  ip?: string;
  userAgent?: string;
}) {
  if (input.action === "TRUST") {
    return approveTrustDevice(input);
  }
  if (input.action === "TEMPORARY") {
    return approveTemporaryAccess(input);
  }
  return declineApproval(input);
}

export async function resolveApprovalEnrollment(enrollmentToken: string) {
  const tokenHash = hashSecret(enrollmentToken);
  const row = await prisma.deviceApprovalRequest.findFirst({
    where: {
      enrollmentTokenHash: tokenHash,
      status: DEVICE_APPROVAL_STATUS.APPROVED,
      enrollmentTokenExpires: { gt: new Date() },
    },
  });
  if (!row) {
    throw Object.assign(new Error("Invalid or expired enrollment token"), {
      statusCode: 401,
    });
  }
  return row;
}

export async function completeApprovalEnrollment(
  requestId: string,
  userId: string,
  deviceId: string,
) {
  await prisma.deviceApprovalRequest.update({
    where: { id: requestId },
    data: {
      resultingDeviceId: deviceId,
      enrollmentTokenHash: null,
      enrollmentTokenExpires: null,
    },
  });
  await prisma.device.update({
    where: { id: deviceId },
    data: { trustLevel: DEVICE_TRUST_LEVELS.STANDARD },
  });
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_ENROLLMENT_COMPLETED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { requestId, deviceId, via: "device_approval" },
  });
}

export async function listTemporaryDevices(userId: string) {
  const now = new Date();
  const devices = await prisma.device.findMany({
    where: {
      userId,
      trustLevel: DEVICE_TRUST_LEVELS.TEMPORARY,
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
    },
    include: {
      sessions: {
        where: { revokedAt: null, expiresAt: { gt: now } },
        include: { application: true },
        orderBy: { lastSeenAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Expire stale temporary devices
  for (const d of devices) {
    if (d.expiresAt && d.expiresAt.getTime() < Date.now()) {
      await prisma.$transaction([
        prisma.device.update({
          where: { id: d.id },
          data: { status: DEVICE_STATUS.REVOKED, revokedAt: new Date() },
        }),
        prisma.session.updateMany({
          where: { deviceId: d.id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    }
  }

  const fresh = await prisma.device.findMany({
    where: {
      userId,
      trustLevel: DEVICE_TRUST_LEVELS.TEMPORARY,
      status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: {
      sessions: {
        where: { revokedAt: null, expiresAt: { gt: now } },
        include: { application: true },
        orderBy: { lastSeenAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return fresh.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    trustLevel: d.trustLevel,
    expiresAt: d.expiresAt?.toISOString() ?? null,
    lastActiveAt: d.lastActiveAt?.toISOString() ?? null,
    applicationName: d.sessions[0]?.application?.name ?? "TrustID",
    sessionId: d.sessions[0]?.id ?? null,
  }));
}

export async function terminateTemporaryDevice(
  userId: string,
  deviceId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const device = await prisma.device.findFirst({
    where: {
      id: deviceId,
      userId,
      trustLevel: DEVICE_TRUST_LEVELS.TEMPORARY,
    },
  });
  if (!device) {
    throw Object.assign(new Error("Temporary device not found"), {
      statusCode: 404,
    });
  }
  await prisma.$transaction([
    prisma.device.update({
      where: { id: deviceId },
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
    metadata: { deviceId, temporary: true },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
  return { ok: true };
}

/** Unused helpers removed — keep file focused */
