import { randomInt } from "node:crypto";
import {
  AUDIT_EVENTS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  SESSION_KINDS,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { hashSecret, randomToken } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { createSession } from "../sessions/service.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60 * 1000;
const ENROLL_TOKEN_TTL_MS = 10 * 60 * 1000;

function generatePairingCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!;
  }
  return out;
}

function guessDeviceName(userAgent?: string) {
  if (!userAgent) return "Signed-in device";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android device";
  if (/Mac OS/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  return "Browser device";
}

/**
 * Create a sign-in code from an authenticated trusted (master) session.
 * The new device claims this code for a session — no extra passkey required.
 * The master device keeps the account's passkey.
 */
export async function createEnrollmentInvite(
  userId: string,
  meta?: { ip?: string; userAgent?: string; deviceId?: string | null },
) {
  let pairingCode = generatePairingCode();
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.devicePairingRequest.findUnique({
      where: { pairingCode },
    });
    if (!clash) break;
    pairingCode = generatePairingCode();
  }

  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const enrollmentToken = randomToken(32);
  const request = await prisma.devicePairingRequest.create({
    data: {
      userId,
      pairingCode,
      requestingDeviceMeta: JSON.stringify({
        initiatedBy: "trusted_session",
        purpose: "cross_device_sign_in",
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        createdAt: new Date().toISOString(),
      }),
      status: "approved",
      approvedByDeviceId: meta?.deviceId ?? null,
      enrollmentTokenHash: hashSecret(enrollmentToken),
      enrollmentTokenExpires: new Date(Date.now() + ENROLL_TOKEN_TTL_MS),
      resolvedAt: new Date(),
      expiresAt,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_ENROLLMENT_CREATED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: {
      requestId: request.id,
      pairingCode,
      autoApproved: true,
      mode: "session_sign_in",
    },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_ENROLLMENT_APPROVED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { requestId: request.id, autoApproved: true, mode: "session_sign_in" },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  const joinPath = `/enroll?code=${pairingCode}`;
  const joinUrl = `${config.webauthn.origin}${joinPath}`;

  return {
    id: request.id,
    pairingCode,
    expiresAt: expiresAt.toISOString(),
    joinPath,
    joinUrl,
    status: request.status,
    canEnroll: true,
    canSignIn: true,
    qr: enrollmentQrPayload(joinUrl),
  };
}

export async function getEnrollmentByCode(code: string) {
  const normalized = code.trim().toUpperCase();
  const row = await prisma.devicePairingRequest.findUnique({
    where: { pairingCode: normalized },
  });
  if (!row) {
    throw Object.assign(new Error("Invalid sign-in code"), { statusCode: 404 });
  }
  const expired =
    row.expiresAt.getTime() < Date.now() ||
    (row.enrollmentTokenExpires != null &&
      row.enrollmentTokenExpires.getTime() < Date.now() &&
      row.status === "approved");

  if (expired && row.status !== "completed" && row.status !== "expired") {
    await prisma.devicePairingRequest.update({
      where: { id: row.id },
      data: { status: "expired", resolvedAt: new Date() },
    });
    throw Object.assign(new Error("Sign-in code expired"), { statusCode: 400 });
  }
  if (row.status === "expired") {
    throw Object.assign(new Error("Sign-in code expired"), { statusCode: 400 });
  }
  if (row.status === "completed") {
    throw Object.assign(new Error("This code was already used"), { statusCode: 400 });
  }
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    canEnroll: row.status === "approved" && Boolean(row.enrollmentTokenHash),
    canSignIn: row.status === "approved" && Boolean(row.enrollmentTokenHash),
  };
}

export async function approveEnrollment(
  userId: string,
  requestId: string,
  approvedByDeviceId?: string,
) {
  const row = await prisma.devicePairingRequest.findFirst({
    where: { id: requestId, userId },
  });
  if (!row) {
    throw Object.assign(new Error("Enrollment not found"), { statusCode: 404 });
  }
  if (row.status === "approved" && row.enrollmentTokenHash) {
    return { id: row.id, status: row.status, enrollmentToken: null as string | null };
  }
  if (row.status !== "pending") {
    throw Object.assign(new Error("Enrollment already resolved"), { statusCode: 400 });
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.devicePairingRequest.update({
      where: { id: requestId },
      data: { status: "expired", resolvedAt: new Date() },
    });
    throw Object.assign(new Error("Enrollment expired"), { statusCode: 400 });
  }

  const enrollmentToken = randomToken(32);
  const updated = await prisma.devicePairingRequest.update({
    where: { id: requestId },
    data: {
      status: "approved",
      approvedByDeviceId: approvedByDeviceId ?? null,
      enrollmentTokenHash: hashSecret(enrollmentToken),
      enrollmentTokenExpires: new Date(Date.now() + ENROLL_TOKEN_TTL_MS),
      resolvedAt: new Date(),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_ENROLLMENT_APPROVED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { requestId },
  });

  return {
    id: updated.id,
    status: updated.status,
    enrollmentToken,
  };
}

/**
 * New device redeems the master-generated code for a session.
 * Does NOT create a passkey — the master device remains the passkey holder.
 */
export async function claimEnrollment(
  code: string,
  meta?: { ip?: string; userAgent?: string; deviceName?: string },
) {
  const status = await getEnrollmentByCode(code);
  if (status.status !== "approved") {
    throw Object.assign(
      new Error(
        status.status === "pending"
          ? "Waiting for approval on your existing trusted device"
          : "Sign-in is not available",
      ),
      { statusCode: 400 },
    );
  }
  const row = await prisma.devicePairingRequest.findUnique({
    where: { pairingCode: code.trim().toUpperCase() },
    include: { user: { include: { profile: true } } },
  });
  if (!row?.enrollmentTokenHash || !row.enrollmentTokenExpires) {
    throw Object.assign(new Error("Sign-in code is not ready"), { statusCode: 400 });
  }
  if (row.enrollmentTokenExpires.getTime() < Date.now()) {
    throw Object.assign(new Error("Sign-in code expired"), { statusCode: 400 });
  }

  const expiresAt = new Date(
    Date.now() + config.temporarySessionHours * 60 * 60 * 1000,
  );
  const device = await prisma.device.create({
    data: {
      userId: row.userId,
      name: meta?.deviceName?.trim() || guessDeviceName(meta?.userAgent),
      status: DEVICE_STATUS.ACTIVE,
      trustLevel: DEVICE_TRUST_LEVELS.TEMPORARY,
      userAgent: meta?.userAgent ?? null,
      lastIp: meta?.ip ?? null,
      lastActiveAt: new Date(),
      expiresAt,
    },
  });

  const { session, token } = await createSession({
    userId: row.userId,
    deviceId: device.id,
    kind: SESSION_KINDS.TEMPORARY,
    expiresAt,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  await prisma.devicePairingRequest.update({
    where: { id: row.id },
    data: {
      status: "completed",
      enrollmentTokenHash: null,
      enrollmentTokenExpires: null,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_ENROLLMENT_COMPLETED,
    userId: row.userId,
    actorType: "user",
    actorId: row.userId,
    metadata: {
      requestId: row.id,
      deviceId: device.id,
      sessionId: session.id,
      mode: "session_sign_in",
      passkeyCreated: false,
    },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  return {
    mode: "session" as const,
    sessionToken: token,
    sessionId: session.id,
    trustId: row.user.trustId,
    userId: row.userId,
    requestId: row.id,
    device: {
      id: device.id,
      name: device.name,
      trustLevel: device.trustLevel,
      expiresAt: expiresAt.toISOString(),
    },
    profile: row.user.profile
      ? {
          firstName: row.user.profile.firstName,
          lastName: row.user.profile.lastName,
          name: `${row.user.profile.firstName} ${row.user.profile.lastName}`,
        }
      : null,
    note: "Signed in with a master-device code. No new passkey was created on this device.",
  };
}

export async function resolveEnrollmentUser(enrollmentToken: string) {
  const tokenHash = hashSecret(enrollmentToken);
  const row = await prisma.devicePairingRequest.findFirst({
    where: {
      enrollmentTokenHash: tokenHash,
      status: "approved",
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

export async function completeEnrollment(requestId: string, userId: string) {
  await prisma.devicePairingRequest.update({
    where: { id: requestId },
    data: {
      status: "completed",
      enrollmentTokenHash: null,
      enrollmentTokenExpires: null,
    },
  });
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_ENROLLMENT_COMPLETED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { requestId },
  });
}

export function enrollmentQrPayload(joinUrl: string) {
  return { joinUrl, type: "trustid.device_enrollment" as const };
}
