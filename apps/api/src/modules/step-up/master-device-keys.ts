/**
 * Which MasterDevice rows can approve step-up. Only an ECDSA P-256 SubjectPublicKeyInfo verifies
 * a step-up signature; rows bound by the account/terminal flows carry an opaque placeholder and
 * must never count as a registered step-up Master Device.
 */
import { createPublicKey } from "node:crypto";
import { prisma } from "../../db/client.js";

/** True only for an ECDSA P-256 SubjectPublicKeyInfo: the key type step-up signatures use. */
export function isStepUpSigningKey(spki: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

/** The subject's step-up Master Device: newest active row holding a usable signing key. */
export async function activeStepUpDevice(userId: string) {
  const rows = await prisma.masterDevice.findMany({
    where: { userId, isMasterDevice: true, status: "active" },
    orderBy: { updatedAt: "desc" },
  });
  return rows.find((row) => isStepUpSigningKey(row.publicKey)) ?? null;
}

/** Master rows that are NOT step-up keys: the terminal bindings other flows may supersede. */
export async function terminalMasterRowIds(userId: string) {
  const rows = await prisma.masterDevice.findMany({
    where: { userId, isMasterDevice: true },
    select: { id: true, publicKey: true },
  });
  return rows.filter((row) => !isStepUpSigningKey(row.publicKey)).map((row) => row.id);
}
