import {
  AUDIT_EVENTS,
  DEVICE_APPROVAL_STATUS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  SESSION_KINDS,
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

async function markExpiredIfNeeded(row: {
  id: string;
  status: string;
  expiresAt: Date;
  userId: string;
}) {
  if (
    row.status === DEVICE_APPROVAL_STATUS.PENDING &&
    row.expiresAt.getTime() < Date.now()
  ) {
    await prisma.deviceApprovalRequest.update({
      where: { id: row.id },
      data: {
        status: DEVICE_APPROVAL_STATUS.EXPIRED,
        resolvedAt: new Date(),
      },
    });
    await recordAudit({
      type: AUDIT_EVENTS.DEVICE_APPROVAL_EXPIRED,
      userId: row.userId,
      actorType: "system",
      actorId: null,
      metadata: { requestId: row.id },
    });
    return true;
  }
  return false;
}

export async function createDeviceApprovalRequest(input: {
  email?: string;
  phone?: string;
  deviceName?: string;
  clientId?: string;
  applicationName?: string;
  location?: string;
  ip?: string;
  userAgent?: string;
}) {
  const user = await findUserByContact(input.email, input.phone);
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
  const expiresAt = new Date(
    Date.now() + config.deviceApprovalTtlMinutes * 60 * 1000,
  );
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
      expiresAt,
    },
  });

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
      row.status === DEVICE_APPROVAL_STATUS.PENDING
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
    if (!row.enrollmentTokenHash || !row.enrollmentTokenExpires) {
      throw Object.assign(new Error("Enrollment token missing"), {
        statusCode: 400,
      });
    }
    if (row.enrollmentTokenExpires.getTime() < Date.now()) {
      throw Object.assign(new Error("Enrollment token expired"), {
        statusCode: 400,
      });
    }
    const enrollmentToken = randomToken(32);
    await prisma.deviceApprovalRequest.update({
      where: { id: row.id },
      data: {
        enrollmentTokenHash: hashSecret(enrollmentToken),
        enrollmentTokenExpires: new Date(Date.now() + 5 * 60 * 1000),
        claimConsumedAt: new Date(),
      },
    });
    return {
      status: DEVICE_APPROVAL_STATUS.APPROVED,
      mode: "trust" as const,
      enrollmentToken,
      requestId: row.id,
      userId: row.userId,
    };
  }

  if (row.status === DEVICE_APPROVAL_STATUS.TEMPORARY) {
    const sessionToken = row.oneTimeSessionToken;
    if (!sessionToken) {
      throw Object.assign(new Error("Temporary session missing"), {
        statusCode: 400,
      });
    }
    await prisma.deviceApprovalRequest.update({
      where: { id: row.id },
      data: {
        oneTimeSessionToken: null,
        claimConsumedAt: new Date(),
      },
    });
    return {
      status: DEVICE_APPROVAL_STATUS.TEMPORARY,
      mode: "temporary" as const,
      sessionToken,
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
    where: { userId, status: DEVICE_APPROVAL_STATUS.PENDING },
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
}) {
  return {
    id: r.id,
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
  };
}

async function expireStaleForUser(userId: string) {
  const stale = await prisma.deviceApprovalRequest.findMany({
    where: {
      userId,
      status: DEVICE_APPROVAL_STATUS.PENDING,
      expiresAt: { lt: new Date() },
    },
  });
  for (const row of stale) {
    await markExpiredIfNeeded(row);
  }
}

async function loadPendingForPrimary(
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
  if (await markExpiredIfNeeded(row)) {
    throw Object.assign(new Error("Approval request expired"), {
      statusCode: 400,
    });
  }
  if (row.status !== DEVICE_APPROVAL_STATUS.PENDING) {
    throw Object.assign(new Error("Request already resolved"), {
      statusCode: 400,
    });
  }
  return row;
}

export async function approveTrustDevice(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  response: AuthenticationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  const row = await loadPendingForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  await verifyReauthentication({
    userId: input.userId,
    deviceId: input.deviceId ?? undefined,
    response: input.response,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const enrollmentToken = randomToken(32);
  const updated = await prisma.deviceApprovalRequest.update({
    where: { id: row.id },
    data: {
      status: DEVICE_APPROVAL_STATUS.APPROVED,
      approvedByDeviceId: input.deviceId ?? null,
      enrollmentTokenHash: hashSecret(enrollmentToken),
      enrollmentTokenExpires: new Date(Date.now() + 5 * 60 * 1000),
      resolvedAt: new Date(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_APPROVAL_APPROVED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { requestId: row.id, mode: "trust" },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "device_approval_resolved",
    title: "Device trusted",
    body: `${row.requestedDeviceName} was approved as a trusted device.`,
    payload: { requestId: row.id, status: updated.status },
  });

  // Enrollment token is claimed by the requesting device via poll/claim
  return { id: updated.id, status: updated.status };
}

export async function approveTemporaryAccess(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  response: AuthenticationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  const row = await loadPendingForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  await verifyReauthentication({
    userId: input.userId,
    deviceId: input.deviceId ?? undefined,
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

  const { session, token } = await createSession({
    userId: input.userId,
    deviceId: tempDevice.id,
    applicationId: row.applicationId,
    kind: SESSION_KINDS.TEMPORARY,
    expiresAt,
    ip: row.ip,
    userAgent: row.userAgent,
  });

  const updated = await prisma.deviceApprovalRequest.update({
    where: { id: row.id },
    data: {
      status: DEVICE_APPROVAL_STATUS.TEMPORARY,
      approvedByDeviceId: input.deviceId ?? null,
      resultingDeviceId: tempDevice.id,
      oneTimeSessionToken: token,
      resolvedAt: new Date(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_APPROVAL_TEMPORARY,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      requestId: row.id,
      deviceId: tempDevice.id,
      sessionId: session.id,
      expiresAt: expiresAt.toISOString(),
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "device_approval_resolved",
    title: "Temporary access granted",
    body: `${row.requestedDeviceName} may use TrustID until ${expiresAt.toLocaleString()}.`,
    payload: { requestId: row.id, status: updated.status },
  });

  return { id: updated.id, status: updated.status, expiresAt: expiresAt.toISOString() };
}

export async function declineApproval(input: {
  userId: string;
  deviceId: string | null | undefined;
  requestId: string;
  response: AuthenticationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  const row = await loadPendingForPrimary(
    input.userId,
    input.requestId,
    input.deviceId,
  );
  await verifyReauthentication({
    userId: input.userId,
    deviceId: input.deviceId ?? undefined,
    response: input.response,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const updated = await prisma.deviceApprovalRequest.update({
    where: { id: row.id },
    data: {
      status: DEVICE_APPROVAL_STATUS.DECLINED,
      approvedByDeviceId: input.deviceId ?? null,
      resolvedAt: new Date(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_APPROVAL_DECLINED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { requestId: row.id },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await createSecurityNotification({
    userId: input.userId,
    type: "device_approval_resolved",
    title: "Device access declined",
    body: `Access for ${row.requestedDeviceName} was declined.`,
    payload: { requestId: row.id, status: updated.status },
  });

  return { id: updated.id, status: updated.status };
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
