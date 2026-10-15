/**
 * Master Device enrollment for authenticated step-up (docs/PORTAL_PROVIDER_CONTRACT_V1.md §4.1).
 *
 * A session proves who is signed in. It never, on its own, creates a Master Device: that needs
 *   1. a TrustID session (the subject),
 *   2. a FRESH passkey assertion WITH USER VERIFICATION (the person, not just their session),
 *   3. proof of possession of the new key over bytes TrustID issued for this enrollment,
 *   4. for Android, a Key Attestation chain proving the key is hardware-backed, non-exportable,
 *      usable only after a strong biometric on every use, made by the genuine TrustID app for
 *      THIS enrollment.
 *
 * Ceremony (all calls in one TrustID session):
 *   POST /enrollment                → enrollment token + attestation_challenge   (key generated next)
 *   POST /enrollment/key            → enrollment token bound to the key + signing_payload
 *   POST /enrollment/reauth         → passkey options bound to THIS enrollment (nonce + key)
 *   POST /enrollment/complete       → attestation + signature + passkey(UV)      → enrolled
 * Removal: POST /revoke/begin (single-use, expiring payload + bound passkey options) → POST /revoke.
 *
 * Passkey challenges for these ceremonies are bound to the operation and its context (HMAC over
 * subject, session, nonce and key / device) and stored under their own purpose: an assertion made
 * for one enrollment or removal cannot be spent on another, nor on any other Trust Center action.
 *
 * Tokens are HMAC-sealed, short-lived and bound to subject, TrustID session, key and the current
 * enrollment state; any enrollment or revocation changes that state, so a token is single-use.
 * Enrollment is disabled unless MASTER_DEVICE_ENROLLMENT=enabled (production: paused).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { deviceFingerprintHash } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { createSecurityNotification } from "../notifications/service.js";
import { reauthenticationOptions, verifyReauthentication } from "../authentication/webauthn.js";
import {
  AttestationRejected,
  fetchRevokedAttestationSerials,
  verifyAndroidKeyAttestation,
  type AttestationPolicy,
  type AttestationResult,
} from "./android-key-attestation.js";
import { activeStepUpDevice, isStepUpSigningKey } from "./master-device-keys.js";
import { StepUpError, verifyMasterDeviceSignature } from "./service.js";

export const ENROLLMENT_SIGNING_VERSION = "trustid-master-device-enroll/v1";
export const ATTESTATION_CHALLENGE_VERSION = "trustid-master-device-attest/v1";
export const REVOKE_SIGNING_VERSION = "trustid-master-device-revoke/v2";
export const ENROLLMENT_TTL_SECONDS = 300;
export const REVOKE_TTL_SECONDS = 300;
/** WebAuthn challenge purposes no other ceremony accepts. */
const CLAIM_PURPOSE = "master_device_claim";
const REAUTH_PURPOSE = "master_device_reauth";
const REAUTH_BINDING_VERSION = "trustid-master-device-reauth/v1";

const MASTER_STATUS = { ACTIVE: "active", REVOKED: "revoked" } as const;
const REVOKED_EVENT = "step_up.master_device_revoked";

const fail = (statusCode: number, code: string, message: string): never => {
  throw new StepUpError(statusCode, code, message);
};

export type EnrollmentSession = { userId: string; sessionId?: string; deviceId?: string | null };
type Meta = { ip?: string; userAgent?: string };

/* ---------------------------------------------------------------- configuration */

export const enrollmentConfig = {
  get enabled() {
    return process.env.MASTER_DEVICE_ENROLLMENT === "enabled";
  },
  /** "android" (default): a verified Android Key Attestation is required. "off": staging only. */
  get attestation(): "android" | "off" {
    const off = process.env.MASTER_DEVICE_ATTESTATION === "off" && process.env.NODE_ENV !== "production";
    return off ? "off" : "android";
  },
  get androidPolicy(): Omit<AttestationPolicy, "revokedSerials" | "now"> {
    return {
      packageNames: (process.env.ANDROID_APP_PACKAGE ?? "com.trustid.device").split(",").map((s) => s.trim()).filter(Boolean),
      signingCertSha256: (process.env.ANDROID_APP_SIGNING_SHA256 ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      minSecurityLevel: process.env.ANDROID_ATTESTATION_MIN_LEVEL === "strongbox" ? "strongbox" : "tee",
      requireVerifiedBoot: process.env.ANDROID_ATTESTATION_REQUIRE_VERIFIED_BOOT !== "false",
      // Can only be raised above the built-in floor (attestation version 3, Keymaster 4).
      minAttestationVersion: Number(process.env.ANDROID_ATTESTATION_MIN_VERSION) || undefined,
      clockSkewSeconds: process.env.ANDROID_ATTESTATION_CLOCK_SKEW_SECONDS ? Number(process.env.ANDROID_ATTESTATION_CLOCK_SKEW_SECONDS) : undefined,
      trustedRootsPem: testRootsPem ?? undefined,
    };
  },
  get revocationCheck() {
    return process.env.ANDROID_ATTESTATION_REVOCATION_CHECK !== "off";
  },
  /**
   * Hours after a revoke WITHOUT the device before a new device may enroll. Unset (default):
   * never by itself — replacing a lost device needs the separate recovery process, not yet built.
   */
  get recoveryCooldownHours(): number | null {
    const raw = Number(process.env.MASTER_DEVICE_RECOVERY_COOLDOWN_HOURS);
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  },
};

let testRootsPem: string[] | null = null;
/** Tests only: trust a generated attestation root instead of Google's. */
export function setAttestationRootsForTests(roots: string[] | null) {
  testRootsPem = roots;
}

/* ---------------------------------------------------------------- helpers */

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("base64url");
/** Audit reference to the TrustID session without storing the session id itself. */
const sessionRef = (sessionId?: string) => (sessionId ? sha256(`session:${sessionId}`).slice(0, 16) : null);

function sealKey() {
  return createHash("sha256").update(`trustid-step-up-enrollment:${config.cookieSecret}`).digest();
}

function decodePublicKey(publicKey: string): Buffer {
  const spki = Buffer.from(publicKey, "base64url");
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

function parseMetadata(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * After a revoke made without the device (lost / stolen), a new device may not enroll until the
 * recovery process clears it (or, where configured, a cooldown elapses). A revoke signed by the
 * device itself, or a later successful enrollment, clears the hold.
 */
async function recoveryHold(userId: string): Promise<{ blocked: boolean; until: Date | null }> {
  const lastRevoke = await prisma.auditEvent.findFirst({
    where: { userId, type: REVOKED_EVENT },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, metadata: true },
  });
  if (!lastRevoke || parseMetadata(lastRevoke.metadata).proof === "device_signature") return { blocked: false, until: null };
  const laterEnrollment = await prisma.auditEvent.findFirst({
    where: { userId, type: AUDIT_EVENTS.MASTER_DEVICE_REGISTERED, createdAt: { gt: lastRevoke.createdAt } },
    select: { id: true },
  });
  if (laterEnrollment) return { blocked: false, until: null };
  const hours = enrollmentConfig.recoveryCooldownHours;
  if (hours === null) return { blocked: true, until: null };
  const until = new Date(lastRevoke.createdAt.getTime() + hours * 3600_000);
  return until > new Date() ? { blocked: true, until } : { blocked: false, until: null };
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

/** The bytes Android Keystore embeds in the attestation (KeyGenParameterSpec.setAttestationChallenge). */
export function attestationChallengeFor(nonce: string): Buffer {
  return createHash("sha256").update(`${ATTESTATION_CHALLENGE_VERSION}:${nonce}`).digest();
}

/** Removal signed by the device itself: single-use (nonce) and short-lived (exp). */
export function revokeSigningPayload(input: { trustId: string; masterDeviceId: string; nonce: string; expiresAt: Date }) {
  return [
    REVOKE_SIGNING_VERSION,
    `sub=${input.trustId}`,
    `device=${input.masterDeviceId}`,
    `nonce=${input.nonce}`,
    `exp=${input.expiresAt.toISOString()}`,
  ].join("\n");
}

/* ---------------------------------------------------------------- tokens */

type EnrollmentClaims = { v: 2; uid: string; sid: string; nonce: string; key: string | null; state: string; exp: number };
type RevocationClaims = { v: 3; uid: string; sid: string; device: string; nonce: string; exp: number };

function sealToken(claims: EnrollmentClaims | RevocationClaims) {
  const body = b64url(JSON.stringify(claims));
  return `${body}.${b64url(createHmac("sha256", sealKey()).update(body).digest())}`;
}

function openSealed(token: string, code: string, label: string): Record<string, unknown> {
  const [body, mac] = token.split(".");
  if (!body || !mac) return fail(400, code, `${label} token is malformed.`);
  const expected = createHmac("sha256", sealKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) fail(400, code, `${label} token is invalid.`);
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail(400, code, `${label} token is malformed.`);
  }
}

function openToken(token: string): EnrollmentClaims {
  const claims = openSealed(token, "invalid_enrollment", "Enrollment");
  if (claims.v !== 2) fail(400, "invalid_enrollment", "Enrollment token is not valid for this ceremony.");
  return claims as EnrollmentClaims;
}

function openRevocation(token: string): RevocationClaims {
  const claims = openSealed(token, "invalid_revocation", "Removal");
  if (claims.v !== 3) fail(400, "invalid_revocation", "Removal token is not valid for this ceremony.");
  return claims as RevocationClaims;
}

/* ---------------------------------------------------------------- operation-bound passkey challenges */

/** 16 random bytes + 16-byte HMAC over the operation context: the challenge itself names the operation. */
function boundChallenge(context: string, nonce: Buffer = randomBytes(16)) {
  const mac = createHmac("sha256", sealKey()).update(`${REAUTH_BINDING_VERSION}|${context}|`).update(nonce).digest().subarray(0, 16);
  return Buffer.concat([nonce, mac]).toString("base64url");
}

function challengeBoundTo(context: string) {
  return (challenge: string) => {
    const raw = Buffer.from(challenge, "base64url");
    if (raw.length !== 32) return false;
    return timingSafeEqual(raw, Buffer.from(boundChallenge(context, raw.subarray(0, 16)), "base64url"));
  };
}

const enrollContext = (s: EnrollmentSession, c: EnrollmentClaims) => `enroll|${s.userId}|${s.sessionId}|${c.nonce}|${c.key}`;
const revokeContext = (s: EnrollmentSession, c: RevocationClaims) => `revoke|${s.userId}|${s.sessionId}|${c.nonce}|${c.device}`;

/** Passkey request options (user verification required) whose challenge is bound to `context`. */
function passkeyOptionsFor(session: EnrollmentSession, context: string) {
  return reauthenticationOptions(session.userId, session.deviceId, "required", { purpose: REAUTH_PURPOSE, challenge: boundChallenge(context) });
}

function verifyBoundPasskey(session: EnrollmentSession, response: unknown, context: string, meta: Meta) {
  return verifyReauthentication({
    userId: session.userId,
    deviceId: session.deviceId ?? undefined,
    response: response as AuthenticationResponseJSON,
    requireUserVerification: true,
    binding: { purpose: REAUTH_PURPOSE, matches: challengeBoundTo(context) },
    ...meta,
  });
}

/** Token checks shared by every step after begin: same subject, same TrustID session, live, state unchanged. */
async function checkToken(session: EnrollmentSession, token: string) {
  const claims = openToken(token);
  if (claims.uid !== session.userId || claims.sid !== session.sessionId) {
    fail(403, "enrollment_session_mismatch", "This enrollment belongs to another session.");
  }
  if (claims.exp * 1000 <= Date.now()) fail(410, "enrollment_expired", "Enrollment expired. Start again.");
  if ((await enrollmentState(session.userId)) !== claims.state) fail(409, "enrollment_stale", "Master Device enrollment changed. Start again.");
  return claims;
}

async function subject(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { trustId: true } });
  if (!user) fail(404, "subject_not_found", "TrustID not found.");
  return user!;
}

function requireEnabled() {
  if (!enrollmentConfig.enabled) {
    fail(403, "master_device_enrollment_disabled", "Adding a new Master Device is not available yet.");
  }
}

/* ---------------------------------------------------------------- ceremony */

export async function beginEnrollment(session: EnrollmentSession, input: { publicKey?: string } = {}) {
  requireEnabled();
  if (!session.sessionId) fail(401, "session_required", "A TrustID session is required.");
  if (await activeStepUpDevice(session.userId)) {
    fail(409, "master_device_already_enrolled", "Revoke the current Master Device before enrolling another.");
  }
  const hold = await recoveryHold(session.userId);
  if (hold.blocked) {
    fail(
      409,
      "master_device_recovery_required",
      hold.until
        ? `A new Master Device can be enrolled after ${hold.until.toISOString()}.`
        : "Your previous Master Device was revoked without the device. Replacing it needs account recovery.",
    );
  }
  // Whole seconds: later steps rebuild the same payload from the token's exp.
  const expiresAt = new Date(Math.floor(Date.now() / 1000 + ENROLLMENT_TTL_SECONDS) * 1000);
  const nonce = randomBytes(32).toString("base64url");
  const state = await enrollmentState(session.userId);
  const base: EnrollmentClaims = { v: 2, uid: session.userId, sid: session.sessionId!, nonce, key: null, state, exp: expiresAt.getTime() / 1000 };
  const out = {
    enrollment: sealToken(base),
    attestation_challenge: b64url(attestationChallengeFor(nonce)),
    expires_at: expiresAt.toISOString(),
  };
  if (!input.publicKey) return out;
  return { ...out, ...(await bindKey(session, base, input.publicKey)) };
}

async function bindKey(session: EnrollmentSession, claims: EnrollmentClaims, publicKey: string) {
  const spki = decodePublicKey(publicKey);
  const { trustId } = await subject(session.userId);
  const bound: EnrollmentClaims = { ...claims, key: sha256(spki) };
  return {
    enrollment: sealToken(bound),
    signing_payload: enrollmentSigningPayload({ nonce: claims.nonce, trustId, publicKey: spki, expiresAt: new Date(claims.exp * 1000) }),
  };
}

/** Passkey options for completing THIS enrollment (after the key is bound). */
export async function enrollmentReauthOptions(session: EnrollmentSession, input: { enrollment: string }) {
  requireEnabled();
  const claims = await checkToken(session, input.enrollment);
  if (!claims.key) fail(409, "enrollment_key_not_bound", "Bind the device key before confirming with a passkey.");
  return passkeyOptionsFor(session, enrollContext(session, claims));
}

/** Second step for keys generated after begin (Android: the key is attested with the challenge). */
export async function bindEnrollmentKey(session: EnrollmentSession, input: { enrollment: string; publicKey: string }) {
  requireEnabled();
  const claims = await checkToken(session, input.enrollment);
  if (claims.key) fail(409, "enrollment_key_already_bound", "This enrollment already has a key. Start again.");
  return bindKey(session, claims, input.publicKey);
}

export async function completeEnrollment(
  session: EnrollmentSession,
  input: { enrollment: string; publicKey: string; deviceFingerprint: string; signature: string; reauth: unknown; attestation?: string[] },
  meta: Meta = {},
) {
  requireEnabled();
  const claims = await checkToken(session, input.enrollment);
  const spki = decodePublicKey(input.publicKey);
  if (!claims.key || sha256(spki) !== claims.key) fail(400, "invalid_enrollment", "public_key does not match this enrollment.");
  if (await activeStepUpDevice(session.userId)) {
    fail(409, "master_device_already_enrolled", "Revoke the current Master Device before enrolling another.");
  }

  // Proof of possession: the new key signed the bytes TrustID issued for this enrollment.
  const { trustId } = await subject(session.userId);
  const payload = enrollmentSigningPayload({ nonce: claims.nonce, trustId, publicKey: spki, expiresAt: new Date(claims.exp * 1000) });
  if (!verifyMasterDeviceSignature(spki, payload, input.signature)) {
    await auditFailure(session, "invalid_signature", meta);
    fail(401, "invalid_signature", "The device did not prove possession of this key.");
  }

  // Hardware assurance (Android Key Attestation), unless explicitly off in a non-production env.
  let attestation: AttestationResult | null = null;
  if (enrollmentConfig.attestation === "android") {
    const policy = enrollmentConfig.androidPolicy;
    if (!policy.signingCertSha256.length) fail(503, "attestation_policy_unconfigured", "Master Device enrollment is not configured.");
    if (!input.attestation?.length) {
      await auditFailure(session, "attestation:missing", meta);
      fail(400, "attestation_required", "A hardware key attestation is required.");
    }
    try {
      const revokedSerials = enrollmentConfig.revocationCheck ? await fetchRevokedAttestationSerials() : new Set<string>();
      attestation = verifyAndroidKeyAttestation(
        input.attestation!,
        {
          publicKeySpki: spki,
          challenge: attestationChallengeFor(claims.nonce),
          keyCreatedNotBefore: new Date((claims.exp - ENROLLMENT_TTL_SECONDS) * 1000),
        },
        { ...policy, revokedSerials },
      );
    } catch (err) {
      const reason = err instanceof AttestationRejected ? err.reason : "attestation_error";
      await auditFailure(session, `attestation:${reason}`, meta);
      if (reason === "revocation_list_unavailable") fail(503, "attestation_unavailable", "Device attestation cannot be checked right now.");
      fail(403, "attestation_rejected", `This device does not meet the Master Device security requirements (${reason}).`);
    }
  }

  // The person, freshly: passkey assertion with user verification on a trusted device, made for THIS enrollment.
  try {
    await verifyBoundPasskey(session, input.reauth, enrollContext(session, claims), meta);
  } catch (err) {
    await auditFailure(session, "reauthentication_failed", meta);
    throw err;
  }

  let fingerprint: string;
  try {
    fingerprint = deviceFingerprintHash(input.deviceFingerprint);
  } catch {
    return fail(400, "invalid_request", "device_fingerprint is required.");
  }
  const existing = await prisma.masterDevice.findUnique({ where: { deviceFingerprint: fingerprint } });
  if (existing && existing.userId !== session.userId) fail(409, "device_bound_elsewhere", "This device is bound to another TrustID.");

  // One enrollment per enrollment state: concurrent completions (same token, or two ceremonies
  // begun from the same state) would otherwise each pass the checks above and leave two active
  // Master Devices, one of which a later revoke would miss.
  const claim = await claimOnce(session.userId, "enroll-state", `${session.userId}:${claims.state}`, new Date(claims.exp * 1000), [
    "enrollment_stale",
    "Master Device enrollment changed. Start again.",
  ]);
  let row;
  try {
    row = existing
      ? await prisma.masterDevice.update({
          where: { id: existing.id },
          data: { publicKey: new Uint8Array(spki), isMasterDevice: true, status: MASTER_STATUS.ACTIVE, lastVerifiedAt: new Date() },
        })
      : await prisma.masterDevice.create({
          data: { userId: session.userId, deviceFingerprint: fingerprint, publicKey: new Uint8Array(spki), isMasterDevice: true, status: MASTER_STATUS.ACTIVE, lastVerifiedAt: new Date() },
        });
  } catch (err) {
    // The state did not change: release the claim so the subject can try again.
    await prisma.webAuthnChallenge.delete({ where: { id: claim } }).catch(() => undefined);
    throw err;
  }

  await recordAudit({
    type: AUDIT_EVENTS.MASTER_DEVICE_REGISTERED,
    userId: session.userId,
    actorType: "user",
    actorId: session.userId,
    metadata: {
      masterDeviceId: row.id,
      purpose: "step_up",
      keyThumbprint: claims.key,
      sessionRef: sessionRef(session.sessionId),
      platform: attestation ? "android" : "unattested",
      securityLevel: attestation?.securityLevel ?? null,
      attestationVersion: attestation?.attestationVersion ?? null,
      verifiedBoot: attestation?.verifiedBoot ?? null,
    },
    ...meta,
  });
  await createSecurityNotification({
    userId: session.userId,
    type: "master_device_enrolled",
    title: "New Master Device enrolled",
    body: "A device was enrolled to approve sensitive actions for your TrustID. If this was not you, revoke it in Trust Center now.",
    payload: { masterDeviceId: row.id },
  });
  return { registered: true, device: { id: row.id, key_thumbprint: claims.key, security_level: attestation?.securityLevel ?? null } };
}

/**
 * Single use: claim `scope`/`value` with a unique row (a second claim fails with `taken`). Stored with
 * WebAuthn challenges under a purpose no WebAuthn ceremony accepts, so it can never be consumed as one.
 */
async function claimOnce(userId: string, scope: string, value: string, expiresAt: Date, taken: [string, string]): Promise<string> {
  try {
    const row = await prisma.webAuthnChallenge.create({
      data: {
        userId,
        type: CLAIM_PURPOSE,
        purpose: CLAIM_PURPOSE,
        challenge: `${CLAIM_PURPOSE}:${scope}:${sha256(value)}`,
        expiresAt,
        consumedAt: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    return fail(409, taken[0], taken[1]);
  }
}

async function auditFailure(session: EnrollmentSession, reason: string, meta: Meta) {
  await recordAudit({
    type: "step_up.master_device_enrollment_failed",
    userId: session.userId,
    actorType: "user",
    actorId: session.userId,
    metadata: { reason, sessionRef: sessionRef(session.sessionId) },
    ...meta,
  });
}

/* ---------------------------------------------------------------- management */

/** Subject: what the Trust Center shows about the step-up Master Device. */
export async function stepUpDeviceStatus(session: EnrollmentSession) {
  const device = await activeStepUpDevice(session.userId);
  let enrollment: Record<string, unknown> = {};
  if (device) {
    const registered = await prisma.auditEvent.findMany({
      where: { userId: session.userId, type: AUDIT_EVENTS.MASTER_DEVICE_REGISTERED },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { metadata: true },
    });
    enrollment = registered.map((r) => parseMetadata(r.metadata)).find((m) => m.masterDeviceId === device.id) ?? {};
  }
  const hold = device ? { blocked: false, until: null } : await recoveryHold(session.userId);
  return {
    enrollment_enabled: enrollmentConfig.enabled,
    registered: Boolean(device),
    device: device
      ? {
          id: device.id,
          enrolled_at: device.createdAt.toISOString(),
          last_used_at: device.lastVerifiedAt?.toISOString() ?? null,
          key_thumbprint: sha256(Buffer.from(device.publicKey)),
          platform: (enrollment.platform as string | undefined) ?? "legacy",
          security_level: (enrollment.securityLevel as string | undefined) ?? null,
        }
      : null,
    recovery_required: hold.blocked && !hold.until,
    enrollment_available_at: hold.until?.toISOString() ?? null,
  };
}

const ACTIVITY_TYPES = [
  AUDIT_EVENTS.MASTER_DEVICE_REGISTERED,
  REVOKED_EVENT,
  "step_up.master_device_enrollment_failed",
  "step_up.challenge_created",
  "step_up.challenge_approved",
  "step_up.challenge_consumed",
  "step_up.challenge_denied",
  "step_up.challenge_expired",
  "step_up.approval_failed",
];

/** Subject: recent Master Device security activity (no addresses, no keys, no tokens). */
export async function stepUpDeviceActivity(session: EnrollmentSession) {
  const events = await prisma.auditEvent.findMany({
    where: { userId: session.userId, type: { in: ACTIVITY_TYPES } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { type: true, actorType: true, actorId: true, createdAt: true, metadata: true },
  });
  return {
    events: events.map((e) => {
      const m = parseMetadata(e.metadata);
      return {
        type: e.type,
        at: e.createdAt.toISOString(),
        client: e.actorType === "application" ? e.actorId : null,
        action: typeof m.action === "string" ? m.action : null,
        reason: typeof m.reason === "string" ? m.reason : null,
      };
    }),
  };
}

/**
 * Subject: start removing the step-up Master Device. Returns a single-use removal token, the
 * expiring bytes the device signs (device in hand) and passkey options bound to this removal.
 */
export async function beginRevocation(session: EnrollmentSession) {
  if (!session.sessionId) fail(401, "session_required", "A TrustID session is required.");
  const device = await activeStepUpDevice(session.userId);
  if (!device) fail(404, "master_device_not_registered", "This TrustID has no registered Master Device.");
  const { trustId } = await subject(session.userId);
  const expiresAt = new Date(Math.floor(Date.now() / 1000 + REVOKE_TTL_SECONDS) * 1000);
  const claims: RevocationClaims = {
    v: 3,
    uid: session.userId,
    sid: session.sessionId!,
    device: device!.id,
    nonce: randomBytes(32).toString("base64url"),
    exp: expiresAt.getTime() / 1000,
  };
  return {
    revocation: sealToken(claims),
    signing_payload: revokeSigningPayload({ trustId, masterDeviceId: device!.id, nonce: claims.nonce, expiresAt }),
    passkey_options: await passkeyOptionsFor(session, revokeContext(session, claims)),
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Subject: revoke the step-up Master Device. Always needs a passkey with user verification made for
 * THIS removal. With the device signature over the removal bytes (device in hand) a new device may be
 * enrolled at once; without it (device lost) a new enrollment needs account recovery (recoveryHold).
 */
export async function revokeStepUpDevice(
  session: EnrollmentSession,
  input: { revocation: string; reauth: unknown; deviceSignature?: string },
  meta: Meta = {},
) {
  const claims = openRevocation(input.revocation);
  if (claims.uid !== session.userId || claims.sid !== session.sessionId) {
    fail(403, "revocation_session_mismatch", "This removal belongs to another session.");
  }
  if (claims.exp * 1000 <= Date.now()) fail(410, "revocation_expired", "Removal expired. Start again.");
  const device = await activeStepUpDevice(session.userId);
  if (!device) fail(404, "master_device_not_registered", "This TrustID has no registered Master Device.");
  if (device!.id !== claims.device) fail(409, "revocation_stale", "The Master Device changed. Start again.");
  await verifyBoundPasskey(session, input.reauth, revokeContext(session, claims), meta);
  const { trustId } = await subject(session.userId);
  let proof: "device_signature" | "passkey_only" = "passkey_only";
  if (input.deviceSignature) {
    const payload = revokeSigningPayload({ trustId, masterDeviceId: device!.id, nonce: claims.nonce, expiresAt: new Date(claims.exp * 1000) });
    if (!verifyMasterDeviceSignature(device!.publicKey, payload, input.deviceSignature)) {
      fail(401, "invalid_signature", "Master Device signature is invalid.");
    }
    proof = "device_signature";
  }
  await claimOnce(session.userId, "revoke", claims.nonce, new Date(claims.exp * 1000), ["revocation_used", "This removal was already used. Start again."]);
  const done = await prisma.masterDevice.updateMany({
    where: { id: device!.id, status: MASTER_STATUS.ACTIVE },
    data: { status: MASTER_STATUS.REVOKED, isMasterDevice: false },
  });
  if (done.count !== 1) fail(409, "master_device_not_registered", "The Master Device was already revoked.");
  // Pending requests, and approvals no app has consumed yet, die with the device.
  await prisma.stepUpChallenge.updateMany({
    where: { userId: session.userId, masterDeviceId: device!.id, status: { in: ["pending", "approved"] }, consumedAt: null },
    data: { status: "cancelled", resolvedAt: new Date() },
  });
  await recordAudit({
    type: REVOKED_EVENT,
    userId: session.userId,
    actorType: "user",
    actorId: session.userId,
    metadata: { masterDeviceId: device!.id, proof, sessionRef: sessionRef(session.sessionId) },
    ...meta,
  });
  await createSecurityNotification({
    userId: session.userId,
    type: "master_device_revoked",
    title: "Master Device revoked",
    body:
      proof === "device_signature"
        ? "Your Master Device was revoked from the device itself."
        : "Your Master Device was revoked without the device. Adding a new one needs account recovery. If this was not you, secure your account.",
    payload: { masterDeviceId: device!.id, proof },
  });
  const hold = proof === "device_signature" ? { blocked: false, until: null } : await recoveryHold(session.userId);
  return { revoked: true, recovery_required: hold.blocked && !hold.until, enrollment_available_at: hold.until?.toISOString() ?? null };
}
