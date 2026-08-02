import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { recordAudit } from "../audit/service.js";
import { createSession } from "../sessions/service.js";

function parseTransports(raw: string): AuthenticatorTransportFuture[] | undefined {
  try {
    const arr = JSON.parse(raw) as AuthenticatorTransportFuture[];
    return arr.length ? arr : undefined;
  } catch {
    return undefined;
  }
}

async function storeChallenge(type: string, challenge: string, userId?: string) {
  await prisma.webAuthnChallenge.create({
    data: {
      type,
      challenge,
      userId: userId ?? null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
}

async function takeChallenge(type: string, userId?: string | null) {
  const row = await prisma.webAuthnChallenge.findFirst({
    where: {
      type,
      expiresAt: { gt: new Date() },
      ...(userId ? { userId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  await prisma.webAuthnChallenge.delete({ where: { id: row.id } });
  return row;
}

export async function registrationOptions(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, credentials: true },
  });
  if (!user) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }

  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpID,
    userName: user.trustId,
    userDisplayName: user.profile
      ? `${user.profile.firstName} ${user.profile.lastName}`
      : user.trustId,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: user.credentials.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await storeChallenge("registration", options.challenge, userId);
  return options;
}

export async function verifyRegistration(input: {
  userId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
  ip?: string;
  userAgent?: string;
}) {
  const row = await takeChallenge("registration", input.userId);
  if (!row) {
    throw Object.assign(new Error("Challenge not found or expired"), { statusCode: 400 });
  }

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: row.challenge,
    expectedOrigin: config.webauthn.origin,
    expectedRPID: config.webauthn.rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error("WebAuthn registration failed"), { statusCode: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const device = await prisma.device.create({
    data: {
      userId: input.userId,
      name: input.deviceName?.trim() || guessDeviceName(input.userAgent),
      status: "trusted",
      userAgent: input.userAgent ?? null,
      platform: credentialDeviceType,
      lastIp: input.ip ?? null,
      lastActiveAt: new Date(),
      trustedAt: new Date(),
    },
  });

  await prisma.credential.create({
    data: {
      userId: input.userId,
      deviceId: device.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: JSON.stringify(input.response.response.transports ?? []),
      aaguid: verification.registrationInfo.aaguid ?? null,
    },
  });

  await prisma.user.update({
    where: { id: input.userId },
    data: { status: "active" },
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

  const { session, token } = await createSession({
    userId: input.userId,
    deviceId: device.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    include: { profile: true },
  });

  return {
    sessionToken: token,
    sessionId: session.id,
    device: {
      id: device.id,
      name: device.name,
      status: device.status,
    },
    trustId: user.trustId,
    profile: user.profile,
  };
}

export async function loginOptions(email?: string, phone?: string) {
  let allowCredentials:
    | { id: string; transports?: AuthenticatorTransportFuture[] }[]
    | undefined;

  if (email || phone) {
    const { findUserByContact } = await import("./service.js");
    const user = await findUserByContact(email, phone);
    if (!user) {
      throw Object.assign(new Error("No account found for that contact"), {
        statusCode: 404,
      });
    }
    const creds = await prisma.credential.findMany({
      where: { userId: user.id, device: { status: "trusted" } },
    });
    if (!creds.length) {
      throw Object.assign(new Error("No passkeys registered"), { statusCode: 400 });
    }
    allowCredentials = creds.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpID,
    userVerification: "preferred",
    allowCredentials,
  });

  await storeChallenge("authentication", options.challenge);
  return options;
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
  if (!cred || cred.device.status !== "trusted") {
    throw Object.assign(new Error("Unknown credential"), { statusCode: 400 });
  }

  const challengeRow = await takeChallenge("authentication");
  if (!challengeRow) {
    throw Object.assign(new Error("Challenge not found or expired"), { statusCode: 400 });
  }

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: config.webauthn.origin,
    expectedRPID: config.webauthn.rpID,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(cred.publicKey),
      counter: Number(cred.counter),
      transports: parseTransports(cred.transports),
    },
  });

  if (!verification.verified) {
    throw Object.assign(new Error("WebAuthn authentication failed"), { statusCode: 400 });
  }

  await prisma.credential.update({
    where: { id: cred.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter) },
  });
  await prisma.device.update({
    where: { id: cred.deviceId },
    data: {
      lastActiveAt: new Date(),
      lastIp: input.ip ?? cred.device.lastIp,
      userAgent: input.userAgent ?? cred.device.userAgent,
    },
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

/** Add an additional passkey/device for an already authenticated user. */
export async function verifyAdditionalDevice(input: {
  userId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
  ip?: string;
  userAgent?: string;
}) {
  return verifyRegistration(input);
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
