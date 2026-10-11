/**
 * Master Device enrollment for authenticated step-up (docs/PORTAL_PROVIDER_CONTRACT_V1.md §4).
 *
 * A step-up Master Device is a MasterDevice row whose public key is an ECDSA P-256 SPKI: the only
 * kind verifyMasterDeviceSignature accepts. Rows bound by the account/terminal flows carry an
 * opaque placeholder instead; they never approve and never count as "registered" for step-up.
 *
 * Enrollment ceremony (subject, TrustID session):
 *   1. begin(public_key)  → a short-lived enrollment token bound to this subject, this TrustID
 *      session and the current enrollment state, plus the exact bytes the new key must sign.
 *   2. complete(...)      → requires a passkey re-authentication on a trusted device (local user
 *      verification) AND a signature by the new key over those bytes (proof of possession).
 * A subject with an enrolled device cannot enroll another: the current device must first be
 * revoked. A revoke signed by the current device takes effect for re-enrollment immediately; a
 * revoke proven only by passkey (device lost) holds re-enrollment for ENROLLMENT_COOLDOWN_HOURS,
 * so a stolen session plus passkey cannot silently swap in an attacker's key.
 *
 * Tokens are HMAC-sealed and stateless. They stop working once enrollment state changes (the
 * state fingerprint they carry no longer matches), which makes a completed token single-use.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { deviceFingerprintHash } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { verifyReauthentication } from "../authentication/webauthn.js";
import { activeStepUpDevice, isStepUpSigningKey } from "./master-device-keys.js";
import { StepUpError, verifyMasterDeviceSignature } from "./service.js";

export const ENROLLMENT_SIGNING_VERSION = "trustid-master-device-enroll/v1";
export const REVOKE_SIGNING_VERSION = "trustid-master-device-revoke/v1";
export const ENROLLMENT_TTL_SECONDS = 300;
export const ENROLLMENT_COOLDOWN_HOURS = 24;

const MASTER_STATUS = { ACTIVE: "active", REVOKED: "revoked", SUPERSEDED: "superseded" } as const;

const fail = (statusCode: number, code: string, message: string): never => {
  throw new StepUpError(statusCode, code, message);
};

export type EnrollmentSession = { userId: string; sessionId?: string; deviceId?: string | null };
type Meta = { ip?: string; userAgent?: string };

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("base64url");

function sealKey() {
  return createHash("sha256").update(`trustid-step-up-enrollment:${config.cookieSecret}`).digest();
}

function decodePublicKey(publicKey: string): Buffer {
  let spki: Buffer;
  try {
    spki = Buffer.from(publicKey, "base64url");
  } catch {
    return fail(400, "invalid_public_key", "public_key must be a base64url SPKI.");
  }
  if (spki.length < 64 || spki.length > 200 || !isStepUpSigningKey(spki)) {
    fail(400, "invalid_public_key", "public_key must be an ECDSA P-256 SubjectPublicKeyInfo.");
  }
  return spki;
}

/** Enrollment state the token is bound to: changes whenever a step-up device is enrolled or revoked. */
async function enrollmentState(userId: string) {
  const latest = await prisma.masterDevice.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, status: true, updatedAt: true, publicKey: true },
  });
  const stepUpRows = latest.filter((row) => isStepUpSigningKey(row.publicKey));
  return sha256(stepUpRows.map((row) => `${row.id}:${row.status}:${row.updatedAt.toISOString()}`).join("|") || "none");
}

/** Revoked without the device's own signature within the cooldown → re-enrollment waits. */
async function cooldownUntil(userId: string): Promise<Date | null> {
  const since = new Date(Date.now() - ENROLLMENT_COOLDOWN_HOURS * 3600_000);
  const audits = await prisma.auditEvent.findMany({
    where: { userId, type: "step_up.master_device_revoked", createdAt: { gt: since } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { createdAt: true, metadata: true },
  });
  const unsigned = audits.find((a) => {
    try {
      return (JSON.parse(String(a.metadata ?? "{}")) as { proof?: string }).proof !== "device_signature";
    } catch {
      return true;
    }
  });
  return unsigned ? new Date(unsigned.createdAt.getTime() + ENROLLMENT_COOLDOWN_HOURS * 3600_000) : null;
}

export function enrollmentSigningPayload(input: { nonce: string; trustId: string; publicKey: Buffer; expiresAt: Date }) {
  // Newline-separated, fixed order: the new key signs these exact bytes.
  return [
    ENROLLMENT_SIGNING_VERSION,
    `enrollment=${input.nonce}`,
    `sub=${input.trustId}`,
    `key=${sha256(input.publicKey)}`,
    `exp=${input.expiresAt.toISOString()}`,
  ].join("\n");
}

export function revokeSigningPayload(input: { trustId: string; masterDeviceId: string }) {
  return [REVOKE_SIGNING_VERSION, `sub=${input.trustId}`, `device=${input.masterDeviceId}`].join("\n");
}

type EnrollmentClaims = { v: 1; uid: string; sid: string; nonce: string; key: string; state: string; exp: number };

function sealToken(claims: EnrollmentClaims) {
  const body = b64url(JSON.stringify(claims));
  return `${body}.${b64url(createHmac("sha256", sealKey()).update(body).digest())}`;
}

function openToken(token: string): EnrollmentClaims {
  const [body, mac] = token.split(".");
  if (!body || !mac) return fail(400, "invalid_enrollment", "Enrollment token is malformed.");
  const expected = createHmac("sha256", sealKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    fail(400, "invalid_enrollment", "Enrollment token is invalid.");
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EnrollmentClaims;
  } catch {
    return fail(400, "invalid_enrollment", "Enrollment token is malformed.");
  }
}

async function subject(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { trustId: true } });
  if (!user) fail(404, "subject_not_found", "TrustID not found.");
  return user!;
}

/** Subject: what the Trust Center shows about the step-up Master Device. */
export async function stepUpDeviceStatus(session: EnrollmentSession) {
  const device = await activeStepUpDevice(session.userId);
  const cooldown = device ? null : await cooldownUntil(session.userId);
  return {
    registered: Boolean(device),
    device: device
      ? {
          id: device.id,
          enrolled_at: device.createdAt.toISOString(),
          last_used_at: device.lastVerifiedAt?.toISOString() ?? null,
          key_thumbprint: sha256(Buffer.from(device.publicKey)),
        }
      : null,
    enrollment_available_at: cooldown?.toISOString() ?? null,
  };
}

export async function beginEnrollment(session: EnrollmentSession, input: { publicKey: string }) {
  if (!session.sessionId) fail(401, "session_required", "A TrustID session is required.");
  const spki = decodePublicKey(input.publicKey);
  if (await activeStepUpDevice(session.userId)) {
    fail(409, "master_device_already_enrolled", "Revoke the current Master Device before enrolling another.");
  }
  const cooldown = await cooldownUntil(session.userId);
  if (cooldown) fail(409, "master_device_enrollment_cooldown", `A new Master Device can be enrolled after ${cooldown.toISOString()}.`);
  const { trustId } = await subject(session.userId);
  const nonce = randomBytes(32).toString("base64url");
  // Whole seconds: complete() rebuilds the same payload from the token's exp.
  const expiresAt = new Date(Math.floor(Date.now() / 1000 + ENROLLMENT_TTL_SECONDS) * 1000);
  const enrollment = sealToken({
    v: 1,
    uid: session.userId,
    sid: session.sessionId!,
    nonce,
    key: sha256(spki),
    state: await enrollmentState(session.userId),
    exp: expiresAt.getTime() / 1000,
  });
  return {
    enrollment,
    signing_payload: enrollmentSigningPayload({ nonce, trustId, publicKey: spki, expiresAt }),
    expires_at: expiresAt.toISOString(),
  };
}

export async function completeEnrollment(
  session: EnrollmentSession,
  input: { enrollment: string; publicKey: string; deviceFingerprint: string; signature: string; reauth: unknown },
  meta: Meta = {},
) {
  const claims = openToken(input.enrollment);
  // Bound to this subject and this TrustID session: another session cannot finish it.
  if (claims.v !== 1 || claims.uid !== session.userId || claims.sid !== session.sessionId) {
    fail(403, "enrollment_session_mismatch", "This enrollment belongs to another session.");
  }
  if (claims.exp * 1000 <= Date.now()) fail(410, "enrollment_expired", "Enrollment expired. Start again.");
  const spki = decodePublicKey(input.publicKey);
  if (sha256(spki) !== claims.key) fail(400, "invalid_enrollment", "public_key does not match this enrollment.");
  // Single use: any enrollment/revocation since begin() changes the state fingerprint.
  if ((await enrollmentState(session.userId)) !== claims.state) {
    fail(409, "enrollment_stale", "Master Device enrollment changed. Start again.");
  }
  if (await activeStepUpDevice(session.userId)) {
    fail(409, "master_device_already_enrolled", "Revoke the current Master Device before enrolling another.");
  }

  const { trustId } = await subject(session.userId);
  const payload = enrollmentSigningPayload({ nonce: claims.nonce, trustId, publicKey: spki, expiresAt: new Date(claims.exp * 1000) });
  if (!verifyMasterDeviceSignature(spki, payload, input.signature)) {
    fail(401, "invalid_signature", "The device did not prove possession of this key.");
  }
  // Local user verification with a passkey on a trusted device (throws 400/401/403).
  await verifyReauthentication({
    userId: session.userId,
    deviceId: session.deviceId ?? undefined,
    response: input.reauth as AuthenticationResponseJSON,
    ...meta,
  });

  let fingerprint: string;
  try {
    fingerprint = deviceFingerprintHash(input.deviceFingerprint);
  } catch {
    return fail(400, "invalid_request", "device_fingerprint is required.");
  }
  const existing = await prisma.masterDevice.findUnique({ where: { deviceFingerprint: fingerprint } });
  if (existing && existing.userId !== session.userId) {
    fail(409, "device_bound_elsewhere", "This device is bound to another TrustID.");
  }
  const row = existing
    ? await prisma.masterDevice.update({
        where: { id: existing.id },
        data: { publicKey: new Uint8Array(spki), isMasterDevice: true, status: MASTER_STATUS.ACTIVE, lastVerifiedAt: new Date() },
      })
    : await prisma.masterDevice.create({
        data: {
          userId: session.userId,
          deviceFingerprint: fingerprint,
          publicKey: new Uint8Array(spki),
          isMasterDevice: true,
          status: MASTER_STATUS.ACTIVE,
          lastVerifiedAt: new Date(),
        },
      });
  await recordAudit({
    type: AUDIT_EVENTS.MASTER_DEVICE_REGISTERED,
    userId: session.userId,
    actorType: "user",
    actorId: session.userId,
    metadata: { masterDeviceId: row.id, purpose: "step_up", keyThumbprint: claims.key },
    ...meta,
  });
  return { registered: true, device: { id: row.id, key_thumbprint: claims.key } };
}

/**
 * Subject: revoke the step-up Master Device. Always needs a passkey re-authentication. With the
 * device's own signature (the device is in hand) a new device may be enrolled at once; without it
 * (device lost) re-enrollment waits ENROLLMENT_COOLDOWN_HOURS.
 */
export async function revokeStepUpDevice(
  session: EnrollmentSession,
  input: { reauth: unknown; deviceSignature?: string },
  meta: Meta = {},
) {
  const device = await activeStepUpDevice(session.userId);
  if (!device) fail(404, "master_device_not_registered", "This TrustID has no registered Master Device.");
  await verifyReauthentication({
    userId: session.userId,
    deviceId: session.deviceId ?? undefined,
    response: input.reauth as AuthenticationResponseJSON,
    ...meta,
  });
  const { trustId } = await subject(session.userId);
  let proof: "device_signature" | "passkey_only" = "passkey_only";
  if (input.deviceSignature) {
    if (!verifyMasterDeviceSignature(device!.publicKey, revokeSigningPayload({ trustId, masterDeviceId: device!.id }), input.deviceSignature)) {
      fail(401, "invalid_signature", "Master Device signature is invalid.");
    }
    proof = "device_signature";
  }
  const done = await prisma.masterDevice.updateMany({
    where: { id: device!.id, status: MASTER_STATUS.ACTIVE },
    data: { status: MASTER_STATUS.REVOKED, isMasterDevice: false },
  });
  if (done.count !== 1) fail(409, "master_device_not_registered", "The Master Device was already revoked.");
  // Pending challenges bound to the revoked device can no longer be approved.
  await prisma.stepUpChallenge.updateMany({
    where: { userId: session.userId, masterDeviceId: device!.id, status: "pending" },
    data: { status: "cancelled", resolvedAt: new Date() },
  });
  await recordAudit({
    type: "step_up.master_device_revoked",
    userId: session.userId,
    actorType: "user",
    actorId: session.userId,
    metadata: { masterDeviceId: device!.id, proof },
    ...meta,
  });
  const availableAt = proof === "device_signature" ? null : new Date(Date.now() + ENROLLMENT_COOLDOWN_HOURS * 3600_000);
  return { revoked: true, enrollment_available_at: availableAt?.toISOString() ?? null };
}
