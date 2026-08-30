import {
  generateRegistrationOptions,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { AUDIT_EVENTS, WEBAUTHN_PURPOSES } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { commitName, newTrustId } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { getDashboardIdentity } from "../identity/service.js";
import {
  assertInstallAvailableForNewTrustId,
} from "./device-install.js";
import { storeWebAuthnChallenge } from "./challenges.js";
import { verifyRegistration } from "./webauthn.js";

/**
 * Begin zero-PII silent account creation: allocate Trust ID + WebAuthn options.
 * No email, phone, or name required — biometric passkey is the identity.
 */
export async function beginSilentRegistration(input: {
  installId: string;
  ip?: string;
  userAgent?: string;
}) {
  const installId = input.installId.trim();
  if (!installId) {
    throw Object.assign(new Error("installId is required"), { statusCode: 400 });
  }
  await assertInstallAvailableForNewTrustId(installId);

  let trustId = newTrustId();
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.user.findUnique({ where: { trustId } });
    if (!clash) break;
    trustId = newTrustId();
  }

  // Placeholder name commitments — no plaintext PII collected at create time.
  const nameCommit = commitName("Trust", "ID");

  const user = await prisma.user.create({
    data: {
      trustId,
      status: "pending_verification",
      profile: {
        create: {
          nameCommitment: nameCommit.nameCommitment,
          nameSalt: nameCommit.nameSalt,
        },
      },
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_CREATED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: { mode: "register_silent", trustId },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_REGISTRATION_STARTED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: { purpose: WEBAUTHN_PURPOSES.REGISTRATION, mode: "register_silent" },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpID,
    userName: user.trustId,
    userDisplayName: user.trustId,
    userID: new TextEncoder().encode(user.id),
    attestationType: config.webauthn.attestationType,
    excludeCredentials: [],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      // Discoverable so future silent login needs zero username.
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });

  const stored = await storeWebAuthnChallenge({
    purpose: WEBAUTHN_PURPOSES.REGISTRATION,
    challenge: options.challenge,
    userId: user.id,
  });

  return {
    userId: user.id,
    trustId: user.trustId,
    installId,
    options: {
      ...options,
      challengeId: stored.id,
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
    },
  };
}

/**
 * Complete silent registration: verify passkey attestation, activate $TID, issue session.
 */
export async function completeSilentRegistration(input: {
  userId: string;
  installId: string;
  response: RegistrationResponseJSON;
  ip?: string;
  userAgent?: string;
}) {
  const result = await verifyRegistration({
    userId: input.userId,
    installId: input.installId,
    response: input.response,
    deviceName: "Trust ID Device",
    ip: input.ip,
    userAgent: input.userAgent,
    presentation: {
      firstName: "Trust",
      lastName: "ID",
      name: "Trust ID",
    },
  });

  if (!result.sessionToken || !result.sessionId) {
    throw Object.assign(new Error("Session was not created"), { statusCode: 500 });
  }

  const identity = await getDashboardIdentity(input.userId, result.sessionId);

  return {
    trustId: result.trustId,
    sessionId: result.sessionId,
    sessionToken: result.sessionToken,
    device: result.device,
    identity,
    mode: "register_silent" as const,
  };
}
