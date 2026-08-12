import { prisma } from "../../db/client.js";
import { openJson, sealJson } from "../../lib/crypto.js";

export type PresentationPayload = {
  firstName?: string;
  lastName?: string;
  name?: string;
  contactType?: string;
  contactValue?: string;
};

export async function sealSessionPresentation(
  sessionId: string,
  payload: PresentationPayload,
  expiresAt: Date,
) {
  await prisma.sessionPresentation.upsert({
    where: { sessionId },
    create: {
      sessionId,
      ciphertext: sealJson(payload),
      expiresAt,
    },
    update: {
      ciphertext: sealJson(payload),
      expiresAt,
    },
  });
}

export async function openSessionPresentation(
  sessionId: string,
): Promise<PresentationPayload | null> {
  const row = await prisma.sessionPresentation.findUnique({
    where: { sessionId },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.sessionPresentation.delete({ where: { sessionId } }).catch(() => undefined);
    return null;
  }
  try {
    return openJson<PresentationPayload>(row.ciphertext);
  } catch {
    return null;
  }
}

export async function clearSessionPresentation(sessionId: string) {
  await prisma.sessionPresentation
    .delete({ where: { sessionId } })
    .catch(() => undefined);
}
