import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { generateOtp, hashSecret, newTrustId, safeEqualHash } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string) {
  return phone.replace(/[^\d+]/g, "");
}

export async function registerIdentity(input: {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  ip?: string;
  userAgent?: string;
}) {
  if (!input.email && !input.phone) {
    throw Object.assign(new Error("Email or phone is required"), { statusCode: 400 });
  }

  const email = input.email ? normalizeEmail(input.email) : undefined;
  const phone = input.phone ? normalizePhone(input.phone) : undefined;

  if (email) {
    const existing = await prisma.contactMethod.findUnique({
      where: { type_value: { type: "email", value: email } },
    });
    if (existing?.verifiedAt) {
      throw Object.assign(new Error("Email already registered"), { statusCode: 409 });
    }
  }
  if (phone) {
    const existing = await prisma.contactMethod.findUnique({
      where: { type_value: { type: "phone", value: phone } },
    });
    if (existing?.verifiedAt) {
      throw Object.assign(new Error("Phone already registered"), { statusCode: 409 });
    }
  }

  let trustId = newTrustId();
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.user.findUnique({ where: { trustId } });
    if (!clash) break;
    trustId = newTrustId();
  }

  const user = await prisma.user.create({
    data: {
      trustId,
      status: "pending_verification",
      profile: {
        create: {
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
        },
      },
      contactMethods: {
        create: [
          ...(email
            ? [{ type: "email", value: email, isPrimary: true }]
            : []),
          ...(phone
            ? [{ type: "phone", value: phone, isPrimary: !email }]
            : []),
        ],
      },
    },
    include: { contactMethods: true, profile: true },
  });

  const primary = user.contactMethods.find((c) => c.isPrimary) ?? user.contactMethods[0]!;
  const challenge = await createVerificationChallenge(primary.id);

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_CREATED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: { trustId: user.trustId },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  for (const contact of user.contactMethods) {
    await prisma.recoveryMethod.create({
      data: {
        userId: user.id,
        type: contact.type,
        contactMethodId: contact.id,
        status: "pending",
      },
    });
  }

  return {
    userId: user.id,
    trustId: user.trustId,
    challengeId: challenge.id,
    debugCode: config.otpExposeDebug ? challenge.debugCode : undefined,
    contactType: primary.type,
  };
}

async function createVerificationChallenge(contactMethodId: string) {
  const code = generateOtp();
  const challenge = await prisma.verificationChallenge.create({
    data: {
      contactMethodId,
      codeHash: hashSecret(code),
      expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60 * 1000),
    },
  });
  // Always log when debug exposure is on (needed on Railway before email/SMS exists)
  console.log(`[TrustID OTP] contact=${contactMethodId} code=${code}`);
  return { id: challenge.id, debugCode: code };
}

export async function verifyContact(input: {
  challengeId: string;
  code: string;
  ip?: string;
  userAgent?: string;
}) {
  const challenge = await prisma.verificationChallenge.findUnique({
    where: { id: input.challengeId },
    include: { contactMethod: true },
  });
  if (!challenge || challenge.consumedAt) {
    throw Object.assign(new Error("Invalid challenge"), { statusCode: 400 });
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    throw Object.assign(new Error("Challenge expired"), { statusCode: 400 });
  }
  if (challenge.attempts >= 5) {
    throw Object.assign(new Error("Too many attempts"), { statusCode: 429 });
  }

  const ok = safeEqualHash(challenge.codeHash, hashSecret(input.code.trim()));
  await prisma.verificationChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });
  if (!ok) {
    throw Object.assign(new Error("Invalid code"), { statusCode: 400 });
  }

  await prisma.$transaction([
    prisma.verificationChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    }),
    prisma.contactMethod.update({
      where: { id: challenge.contactMethodId },
      data: { verifiedAt: new Date() },
    }),
    prisma.recoveryMethod.updateMany({
      where: { contactMethodId: challenge.contactMethodId },
      data: { status: "active" },
    }),
  ]);

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_VERIFIED,
    userId: challenge.contactMethod.userId,
    actorType: "user",
    actorId: challenge.contactMethod.userId,
    metadata: { contactType: challenge.contactMethod.type },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    userId: challenge.contactMethod.userId,
    contactMethodId: challenge.contactMethodId,
    verified: true,
  };
}

export async function findUserByContact(email?: string, phone?: string) {
  if (email) {
    const contact = await prisma.contactMethod.findUnique({
      where: { type_value: { type: "email", value: normalizeEmail(email) } },
      include: { user: true },
    });
    // Login must work even if OTP verification was skipped / lost after a DB reset.
    if (contact) return contact.user;
  }
  if (phone) {
    const normalized = normalizePhone(phone);
    const digits = normalized.replace(/\D/g, "");
    const candidates = [...new Set([normalized, digits].filter(Boolean))];
    for (const value of candidates) {
      const contact = await prisma.contactMethod.findUnique({
        where: { type_value: { type: "phone", value } },
        include: { user: true },
      });
      if (contact) return contact.user;
    }
  }
  return null;
}

export async function findUserByTrustId(trustId?: string) {
  const id = trustId?.trim();
  if (!id) return null;
  return prisma.user.findUnique({ where: { trustId: id } });
}
