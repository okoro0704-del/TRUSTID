import { randomBytes } from "node:crypto";
import type { WebAuthnPurpose } from "@trustid/shared";
import { prisma } from "../../db/client.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Cryptographically secure challenge (never Math.random). */
export function createSecureChallenge(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function storeWebAuthnChallenge(input: {
  purpose: WebAuthnPurpose;
  challenge: string;
  userId?: string | null;
  ttlMs?: number;
}) {
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? CHALLENGE_TTL_MS));
  return prisma.webAuthnChallenge.create({
    data: {
      purpose: input.purpose,
      type: input.purpose,
      challenge: input.challenge,
      userId: input.userId ?? null,
      expiresAt,
    },
  });
}

export async function consumeWebAuthnChallenge(input: {
  challenge: string;
  purpose: WebAuthnPurpose | WebAuthnPurpose[];
  userId?: string | null;
}) {
  const purposes = Array.isArray(input.purpose) ? input.purpose : [input.purpose];
  const row = await prisma.webAuthnChallenge.findUnique({
    where: { challenge: input.challenge },
  });

  if (!row) {
    return { ok: false as const, reason: "unknown" as const };
  }
  if (row.consumedAt) {
    return { ok: false as const, reason: "consumed" as const };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.webAuthnChallenge.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    return { ok: false as const, reason: "expired" as const };
  }
  if (!purposes.includes(row.purpose as WebAuthnPurpose)) {
    return { ok: false as const, reason: "purpose_mismatch" as const };
  }
  if (input.userId && row.userId && row.userId !== input.userId) {
    return { ok: false as const, reason: "user_mismatch" as const };
  }

  const updated = await prisma.webAuthnChallenge.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
  return { ok: true as const, challenge: updated };
}

/** Extract base64url challenge from a WebAuthn clientDataJSON string. */
export function extractClientChallenge(clientDataJSON: string): string | null {
  try {
    const json = Buffer.from(clientDataJSON, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { challenge?: string };
    return parsed.challenge ?? null;
  } catch {
    return null;
  }
}
