import { prisma } from "../../db/client.js";
import { installLookupHash } from "../../lib/crypto.js";

const INSTALL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertValidInstallId(installId: string | undefined | null): string {
  const id = (installId ?? "").trim();
  if (!id || !INSTALL_ID_RE.test(id)) {
    throw Object.assign(new Error("A valid device install id is required"), {
      statusCode: 400,
    });
  }
  return id;
}

export async function getInstallOccupancy(installId: string) {
  const installHash = installLookupHash(assertValidInstallId(installId));
  const row = await prisma.deviceInstall.findUnique({
    where: { installHash },
    include: { user: { select: { id: true, trustId: true, status: true } } },
  });
  if (!row?.user) return { occupied: false as const };
  return {
    occupied: true as const,
    userId: row.user.id,
    trustId: row.user.trustId,
    status: row.user.status,
  };
}

/**
 * Reject creating a second TrustID on a phone that already has a living binding.
 * Orphan rows (missing user) are treated as free — wipe reclaim path.
 */
export async function assertInstallAvailableForNewTrustId(installId: string) {
  const occ = await getInstallOccupancy(installId);
  if (occ.occupied) {
    throw Object.assign(
      new Error("This device already has a TrustID. Sign in with your passkey instead."),
      { statusCode: 409, code: "device_occupied" },
    );
  }
}

/**
 * Bind install → user after successful passkey registration.
 * Reclaims stale unique rows from wiped/orphaned installs.
 */
export async function bindInstallToUser(installId: string, userId: string) {
  const id = assertValidInstallId(installId);
  const installHash = installLookupHash(id);

  const existing = await prisma.deviceInstall.findUnique({
    where: { installHash },
  });
  if (existing) {
    if (existing.userId === userId) {
      await prisma.deviceInstall.update({
        where: { installHash },
        data: { updatedAt: new Date() },
      });
      return;
    }
    const owner = await prisma.user.findUnique({ where: { id: existing.userId } });
    if (owner) {
      throw Object.assign(
        new Error("This device already has a TrustID. Sign in with your passkey instead."),
        { statusCode: 409, code: "device_occupied" },
      );
    }
    await prisma.deviceInstall.delete({ where: { installHash } });
  }

  await prisma.deviceInstall.create({
    data: { installHash, userId },
  });
}
