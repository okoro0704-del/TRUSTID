import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import {
  AUDIT_EVENTS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  WEBAUTHN_PURPOSES,
  isDeviceCredentialActive,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { recordAudit } from "../audit/service.js";
import { createSession } from "../sessions/service.js";
import { chooseInitialTrustLevel } from "../devices/trust.js";
import {
  consumeWebAuthnChallenge,
  extractClientChallenge,
  storeWebAuthnChallenge,
} from "./challenges.js";
import { evaluateSignatureCounter } from "./counter.js";

function parseTransports(raw: string): AuthenticatorTransportFuture[] | undefined {
  try {
    const arr = JSON.parse(raw) as AuthenticatorTransportFuture[];
    return arr.length ? arr : undefined;
  } catch {
    return undefined;
  }
}

async function failRegistration(
  userId: string | undefined,
  reason: string,
  meta?: { ip?: string; userAgent?: string },
) {
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_REGISTRATION_FAILED,
    userId: userId ?? null,
    actorType: userId ? "user" : "system",
    actorId: userId ?? null,
    metadata: { reason },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

async function failAuthentication(
  userId: string | undefined,
  reason: string,
  meta?: { ip?: string; userAgent?: string; credentialId?: string },
) {
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_AUTHENTICATION_FAILED,
    userId: userId ?? null,
    actorType: userId ? "user" : "system",
    actorId: userId ?? null,
    metadata: {
      reason,
      credentialId: meta?.credentialId ? "[redacted-id-present]" : undefined,
    },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

export async function registrationOptions(
  userId: string,
  purpose: typeof WEBAUTHN_PURPOSES.REGISTRATION | typeof WEBAUTHN_PURPOSES.DEVICE_ADDITION =
    WEBAUTHN_PURPOSES.REGISTRATION,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, credentials: true },
  });
  if (!user) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_REGISTRATION_STARTED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { purpose },
  });

  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpID,
    userName: user.trustId,
    userDisplayName: user.profile
      ? `${user.profile.firstName} ${user.profile.lastName}`
      : user.trustId,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: user.credentials
      .filter((c) => c.status !== DEVICE_STATUS.REVOKED)
      .map((c) => ({
        id: c.credentialId,
        transports: parseTransports(c.transports),
      })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      requireResidentKey: false,
      userVerification: "required",
    },
  });

  const stored = await storeWebAuthnChallenge({
    purpose,
    challenge: options.challenge,
    userId,
  });

  return {
    ...options,
    challengeId: stored.id,
    purpose,
  };
}

export async function verifyRegistration(input: {
  userId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
  ip?: string;
  userAgent?: string;
  /** When true, skip creating a new TrustID session (already authenticated add-device). */
  skipSession?: boolean;
  purpose?: typeof WEBAUTHN_PURPOSES.REGISTRATION | typeof WEBAUTHN_PURPOSES.DEVICE_ADDITION;
}) {
  const purpose = input.purpose ?? WEBAUTHN_PURPOSES.REGISTRATION;
  const clientChallenge = extractClientChallenge(input.response.response.clientDataJSON);
  if (!clientChallenge) {
    await failRegistration(input.userId, "missing_client_challenge", input);
    throw Object.assign(new Error("Invalid credential response"), { statusCode: 400 });
  }

  const consumed = await consumeWebAuthnChallenge({
    challenge: clientChallenge,
    purpose: [WEBAUTHN_PURPOSES.REGISTRATION, WEBAUTHN_PURPOSES.DEVICE_ADDITION],
    userId: input.userId,
  });
  if (!consumed.ok) {
    await failRegistration(input.userId, `challenge_${consumed.reason}`, input);
    const message =
      consumed.reason === "expired"
        ? "Challenge expired"
        : consumed.reason === "consumed"
          ? "Challenge already used"
          : "Challenge not found or invalid";
    throw Object.assign(new Error(message), { statusCode: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: consumed.challenge.challenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    await failRegistration(
      input.userId,
      err instanceof Error ? err.message : "attestation_verify_error",
      input,
    );
    throw Object.assign(new Error("WebAuthn registration failed"), { statusCode: 400 });
  }

  if (!verification.verified || !verification.registrationInfo) {
    await failRegistration(input.userId, "not_verified", input);
    throw Object.assign(new Error("WebAuthn registration failed"), { statusCode: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const existing = await prisma.credential.findUnique({
    where: { credentialId: credential.id },
  });
  if (existing) {
    await failRegistration(input.userId, "duplicate_credential", input);
    throw Object.assign(
      new Error("Credential already registered to a TrustID"),
      { statusCode: 409 },
    );
  }

  const deviceType = inferDeviceType(input.userAgent, credentialDeviceType);
  const trustLevel = await chooseInitialTrustLevel(input.userId);
  const device = await prisma.device.create({
    data: {
      userId: input.userId,
      name: input.deviceName?.trim() || guessDeviceName(input.userAgent),
      status: DEVICE_STATUS.ACTIVE,
      trustLevel,
      deviceType,
      userAgent: input.userAgent ?? null,
      platform: credentialDeviceType,
      lastIp: input.ip ?? null,
      lastActiveAt: new Date(),
      trustedAt: new Date(),
    },
  });

  try {
    await prisma.credential.create({
      data: {
        userId: input.userId,
        deviceId: device.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: JSON.stringify(input.response.response.transports ?? []),
        aaguid: verification.registrationInfo.aaguid ?? null,
        authenticatorAttachment: "platform",
        credentialDeviceType,
        backedUp: credentialBackedUp,
        displayName: input.deviceName?.trim() || guessDeviceName(input.userAgent),
        status: DEVICE_STATUS.ACTIVE,
        lastUsedAt: new Date(),
      },
    });
  } catch {
    await prisma.device.delete({ where: { id: device.id } }).catch(() => undefined);
    await failRegistration(input.userId, "duplicate_credential_race", input);
    throw Object.assign(
      new Error("Credential already registered to a TrustID"),
      { statusCode: 409 },
    );
  }

  await prisma.user.update({
    where: { id: input.userId },
    data: { status: "active" },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_REGISTRATION_COMPLETED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      deviceId: device.id,
      purpose,
      backedUp: credentialBackedUp,
      credentialDeviceType,
      authenticatorAttachment: "platform",
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_REGISTERED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      deviceId: device.id,
      backedUp: credentialBackedUp,
      deviceType: credentialDeviceType,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  let sessionToken: string | undefined;
  let sessionId: string | undefined;
  if (!input.skipSession) {
    const created = await createSession({
      userId: input.userId,
      deviceId: device.id,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    sessionToken = created.token;
    sessionId = created.session.id;
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    include: { profile: true },
  });

  return {
    sessionToken,
    sessionId,
    device: {
      id: device.id,
      name: device.name,
      status: device.status,
      createdAt: device.createdAt.toISOString(),
      lastUsedAt: device.lastActiveAt?.toISOString() ?? null,
    },
    trustId: user.trustId,
    profile: user.profile,
  };
}

export async function loginOptions(email?: string, phone?: string) {
  let allowCredentials:
    | { id: string; transports?: AuthenticatorTransportFuture[] }[]
    | undefined;
  let userId: string | undefined;

  if (email || phone) {
    const { findUserByContact } = await import("./service.js");
    const user = await findUserByContact(email, phone);
    if (!user) {
      throw Object.assign(new Error("No account found for that contact"), {
        statusCode: 404,
      });
    }
    userId = user.id;
    const creds = await prisma.credential.findMany({
      where: {
        userId: user.id,
        status: { not: DEVICE_STATUS.REVOKED },
        device: { status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] } },
      },
    });
    if (!creds.length) {
      throw Object.assign(new Error("No passkeys registered"), { statusCode: 400 });
    }
    allowCredentials = creds.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    }));
  }

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_AUTHENTICATION_STARTED,
    userId: userId ?? null,
    actorType: userId ? "user" : "system",
    actorId: userId ?? null,
    metadata: { purpose: WEBAUTHN_PURPOSES.AUTHENTICATION },
  });

  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpID,
    userVerification: "required",
    allowCredentials,
  });

  const stored = await storeWebAuthnChallenge({
    purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
    challenge: options.challenge,
    userId,
  });

  return {
    ...options,
    challengeId: stored.id,
    purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
  };
}

export async function verifyLogin(input: {
  response: AuthenticationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  const cred = await prisma.credential.findUnique({
    where: { credentialId: input.response.id },
    include: { user: { include: { profile: true } }, device: true },
  });

  if (!cred) {
    await failAuthentication(undefined, "unknown_credential", {
      ...input,
      credentialId: input.response.id,
    });
    throw Object.assign(new Error("Unknown credential"), { statusCode: 400 });
  }

  if (
    cred.status === DEVICE_STATUS.REVOKED ||
    !isDeviceCredentialActive(cred.device.status)
  ) {
    await failAuthentication(cred.userId, "revoked_credential", {
      ...input,
      credentialId: input.response.id,
    });
    throw Object.assign(new Error("Credential revoked"), { statusCode: 403 });
  }

  const clientChallenge = extractClientChallenge(input.response.response.clientDataJSON);
  if (!clientChallenge) {
    await failAuthentication(cred.userId, "missing_client_challenge", input);
    throw Object.assign(new Error("Invalid assertion response"), { statusCode: 400 });
  }

  const consumed = await consumeWebAuthnChallenge({
    challenge: clientChallenge,
    purpose: [
      WEBAUTHN_PURPOSES.AUTHENTICATION,
      WEBAUTHN_PURPOSES.REAUTHENTICATION,
    ],
  });
  if (!consumed.ok) {
    await failAuthentication(cred.userId, `challenge_${consumed.reason}`, input);
    const message =
      consumed.reason === "expired"
        ? "Challenge expired"
        : consumed.reason === "consumed"
          ? "Challenge already used"
          : "Challenge not found or invalid";
    throw Object.assign(new Error(message), { statusCode: 400 });
  }
  if (consumed.challenge.userId && consumed.challenge.userId !== cred.userId) {
    await failAuthentication(cred.userId, "challenge_user_mismatch", input);
    throw Object.assign(new Error("Challenge not found or invalid"), { statusCode: 400 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: consumed.challenge.challenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(cred.publicKey),
        counter: Number(cred.counter),
        transports: parseTransports(cred.transports),
      },
    });
  } catch (err) {
    await failAuthentication(
      cred.userId,
      err instanceof Error ? err.message : "assertion_verify_error",
      input,
    );
    throw Object.assign(new Error("WebAuthn authentication failed"), { statusCode: 400 });
  }

  if (!verification.verified) {
    await failAuthentication(cred.userId, "not_verified", input);
    throw Object.assign(new Error("WebAuthn authentication failed"), { statusCode: 400 });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const counterDecision = evaluateSignatureCounter(cred.counter, newCounter);
  if (counterDecision.warning) {
    await recordAudit({
      type: AUDIT_EVENTS.DEVICE_SIGNATURE_COUNTER_WARNING,
      userId: cred.userId,
      actorType: "system",
      actorId: cred.userId,
      metadata: {
        deviceId: cred.deviceId,
        reason: counterDecision.reason,
        storedCounter: cred.counter.toString(),
        newCounter,
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  await prisma.credential.update({
    where: { id: cred.id },
    data: {
      counter: BigInt(newCounter),
      lastUsedAt: new Date(),
    },
  });
  await prisma.device.update({
    where: { id: cred.deviceId },
    data: {
      lastActiveAt: new Date(),
      lastIp: input.ip ?? cred.device.lastIp,
      userAgent: input.userAgent ?? cred.device.userAgent,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_AUTHENTICATION_COMPLETED,
    userId: cred.userId,
    actorType: "user",
    actorId: cred.userId,
    metadata: {
      deviceId: cred.deviceId,
      userVerified: verification.authenticationInfo.userVerified,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const { session, token } = await createSession({
    userId: cred.userId,
    deviceId: cred.deviceId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    sessionToken: token,
    sessionId: session.id,
    trustId: cred.user.trustId,
    profile: cred.user.profile,
    device: {
      id: cred.device.id,
      name: cred.device.name,
      status: cred.device.status,
    },
  };
}

/** Options for local UV before sensitive Trust Center actions. */
export async function reauthenticationOptions(userId: string, deviceId?: string | null) {
  const creds = await prisma.credential.findMany({
    where: {
      userId,
      status: { not: DEVICE_STATUS.REVOKED },
      device: {
        status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
        trustLevel: { not: DEVICE_TRUST_LEVELS.TEMPORARY },
        ...(deviceId ? { id: deviceId } : {}),
      },
    },
  });
  if (!creds.length) {
    throw Object.assign(new Error("No trusted passkey on this device"), {
      statusCode: 400,
    });
  }

  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpID,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
  });

  await storeWebAuthnChallenge({
    purpose: WEBAUTHN_PURPOSES.REAUTHENTICATION,
    challenge: options.challenge,
    userId,
  });

  return options;
}

/**
 * Verify local user presence for approve / promote / revoke actions.
 * Does not create a new session.
 */
export async function verifyReauthentication(input: {
  userId: string;
  deviceId?: string;
  response: AuthenticationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  const cred = await prisma.credential.findUnique({
    where: { credentialId: input.response.id },
    include: { device: true, user: true },
  });
  if (
    !cred ||
    cred.userId !== input.userId ||
    cred.status === DEVICE_STATUS.REVOKED ||
    !isDeviceCredentialActive(cred.device.status) ||
    cred.device.trustLevel === DEVICE_TRUST_LEVELS.TEMPORARY
  ) {
    await failAuthentication(input.userId, "reauth_invalid_credential", input);
    throw Object.assign(new Error("Re-authentication failed"), { statusCode: 401 });
  }
  if (input.deviceId && cred.deviceId !== input.deviceId) {
    await failAuthentication(input.userId, "reauth_device_mismatch", input);
    throw Object.assign(
      new Error("Use the passkey on this trusted device"),
      { statusCode: 403 },
    );
  }

  const clientChallenge = extractClientChallenge(input.response.response.clientDataJSON);
  if (!clientChallenge) {
    throw Object.assign(new Error("Invalid credential response"), { statusCode: 400 });
  }
  const consumed = await consumeWebAuthnChallenge({
    challenge: clientChallenge,
    purpose: [WEBAUTHN_PURPOSES.REAUTHENTICATION],
    userId: input.userId,
  });
  if (!consumed.ok) {
    throw Object.assign(new Error("Challenge not found or invalid"), { statusCode: 400 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: consumed.challenge.challenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(cred.publicKey),
        counter: Number(cred.counter),
        transports: parseTransports(cred.transports),
      },
    });
  } catch {
    throw Object.assign(new Error("Re-authentication failed"), { statusCode: 401 });
  }
  if (!verification.verified) {
    throw Object.assign(new Error("Re-authentication failed"), { statusCode: 401 });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  evaluateSignatureCounter(cred.counter, newCounter);
  await prisma.credential.update({
    where: { id: cred.id },
    data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
  });
  await prisma.device.update({
    where: { id: cred.deviceId },
    data: { lastActiveAt: new Date() },
  });

  return { deviceId: cred.deviceId, userVerified: verification.authenticationInfo.userVerified };
}

/** Add an additional trusted credential/device for an authenticated user. */
export async function verifyAdditionalDevice(input: {
  userId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
  ip?: string;
  userAgent?: string;
}) {
  return verifyRegistration({
    ...input,
    skipSession: true,
    purpose: WEBAUTHN_PURPOSES.DEVICE_ADDITION,
  });
}

function guessDeviceName(ua?: string | null) {
  if (!ua) return "Trusted device";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android device";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Linux/i.test(ua)) return "Linux device";
  return "Trusted device";
}

function inferDeviceType(ua?: string | null, credentialDeviceType?: string) {
  if (/iPhone|iPad|Android|Mobile/i.test(ua ?? "")) return "mobile";
  if (/Mac|Windows|Linux|CrOS/i.test(ua ?? "")) return "desktop";
  return credentialDeviceType ?? "unknown";
}
