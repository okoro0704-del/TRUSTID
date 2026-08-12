import { AUDIT_EVENTS } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import {
  commitContact,
  commitName,
  contactLookupHash,
  generateOtp,
  hashSecret,
  newTrustId,
  normalizeContact,
  verifySecret,
} from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";

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

  const email = input.email
    ? normalizeContact("email", input.email)
    : undefined;
  const phone = input.phone
    ? normalizeContact("phone", input.phone)
    : undefined;

  if (email) {
    const lookupHash = contactLookupHash("email", email);
    const existing = await prisma.contactMethod.findUnique({
      where: { type_lookupHash: { type: "email", lookupHash } },
    });
    if (existing?.verifiedAt) {
      throw Object.assign(new Error("Email already registered"), { statusCode: 409 });
    }
  }
  if (phone) {
    const lookupHash = contactLookupHash("phone", phone);
    const existing = await prisma.contactMethod.findUnique({
      where: { type_lookupHash: { type: "phone", lookupHash } },
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

  const nameCommit = commitName(input.firstName, input.lastName);
  const contacts: {
    type: string;
    lookupHash: string;
    commitment: string;
    salt: string;
    isPrimary: boolean;
  }[] = [];
  if (email) {
    const c = commitContact("email", email);
    contacts.push({ type: "email", ...c, isPrimary: true });
  }
  if (phone) {
    const c = commitContact("phone", phone);
    contacts.push({ type: "phone", ...c, isPrimary: !email });
  }

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
      contactMethods: { create: contacts },
    },
    include: { contactMethods: true, profile: true },
  });

  const primary = user.contactMethods.find((c) => c.isPrimary) ?? user.contactMethods[0]!;
  const challenge = await createVerificationChallenge(primary.id, primary.lookupHash);

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

  // Ephemeral presentation hints for later session seal (returned once; not stored)
  return {
    userId: user.id,
    trustId: user.trustId,
    challengeId: challenge.id,
    debugCode: config.otpExposeDebug ? challenge.debugCode : undefined,
    contactType: primary.type,
    /** Client may hold ephemerally until passkey session; never written to DB */
    _ephemeral: {
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      contactType: primary.type,
      contactValue: email ?? phone ?? "",
    },
  };
}

async function createVerificationChallenge(
  contactMethodId: string,
  lookupHashPrefix?: string,
) {
  const code = generateOtp();
  const challenge = await prisma.verificationChallenge.create({
    data: {
      contactMethodId,
      codeHash: hashSecret(code),
      expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60 * 1000),
    },
  });
  const hint = lookupHashPrefix ? lookupHashPrefix.slice(0, 8) : contactMethodId.slice(0, 8);
  if (config.otpExposeDebug) {
    console.log(`[TrustID OTP] lookup=${hint}… code=${code}`);
  }
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

  const ok = verifySecret(input.code.trim(), challenge.codeHash);
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
    const lookupHash = contactLookupHash("email", email);
    const contact = await prisma.contactMethod.findUnique({
      where: { type_lookupHash: { type: "email", lookupHash } },
      include: { user: true },
    });
    if (contact) return contact.user;
  }
  if (phone) {
    const normalized = normalizeContact("phone", phone);
    const digits = normalized.replace(/\D/g, "");
    const candidates = [...new Set([normalized, digits].filter(Boolean))];
    for (const value of candidates) {
      const lookupHash = contactLookupHash("phone", value);
      const contact = await prisma.contactMethod.findUnique({
        where: { type_lookupHash: { type: "phone", lookupHash } },
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
