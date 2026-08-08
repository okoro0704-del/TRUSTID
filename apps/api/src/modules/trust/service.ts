import {
  DEVICE_STATUS,
  IDENTITY_VERIFICATION_STATUS,
  TRUST_TIER_LABELS,
  TRUST_TIERS,
  isDeviceCredentialActive,
  trustStarsFromTier,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { getIdentityVerificationSummary } from "../identity-verification/service.js";

export async function computeTrustLevel(userId: string) {
  const [activeDevices, verification] = await Promise.all([
    prisma.device.count({
      where: {
        userId,
        status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
      },
    }),
    getIdentityVerificationSummary(userId),
  ]);

  let tier: number = TRUST_TIERS.TIER_0;
  if (activeDevices > 0) tier = TRUST_TIERS.TIER_1;
  if (verification.status === IDENTITY_VERIFICATION_STATUS.VERIFIED) {
    tier = TRUST_TIERS.TIER_2;
  }
  // Tier 3 reserved for future high-assurance providers

  const { stars, maxStars } = trustStarsFromTier(tier);

  return {
    tier,
    /** Same value Life OS displays as filled stars */
    stars,
    maxStars,
    label: TRUST_TIER_LABELS[tier] ?? "Unknown",
    trustedDevices: activeDevices,
    identityVerification: verification,
    /** True only for non-mock verified ceremonies */
    governmentVerified:
      verification.status === IDENTITY_VERIFICATION_STATUS.VERIFIED &&
      !verification.isMock,
  };
}

export async function getTrustCenterSummary(userId: string, currentSessionId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user) return null;

  const trust = await computeTrustLevel(userId);
  const [
    devices,
    connectedApps,
    sessions,
    passkeys,
    recentEvents,
  ] = await Promise.all([
    prisma.device.count({
      where: {
        userId,
        status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
      },
    }),
    prisma.authorization.count({ where: { userId, status: "active" } }),
    prisma.session.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
    prisma.credential.count({
      where: { userId, status: { not: DEVICE_STATUS.REVOKED } },
    }),
    prisma.auditEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const recommendations: string[] = [];
  if (devices < 2) {
    recommendations.push("Add a second trusted device so you can recover access if one is lost.");
  }
  if (trust.tier < TRUST_TIERS.TIER_2) {
    recommendations.push(
      "Identity verification is not completed. Higher assurance will be available when a verification provider is enabled.",
    );
  }
  if (passkeys < 1) {
    recommendations.push("Register a passkey on this device to secure your TrustID.");
  }

  return {
    identity: {
      trustId: user.trustId,
      status: user.status,
      name: user.profile
        ? `${user.profile.firstName} ${user.profile.lastName}`
        : null,
    },
    trust,
    counts: {
      trustedDevices: devices,
      connectedApplications: connectedApps,
      activeSessions: sessions,
      passkeys,
    },
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt.toISOString(),
    })),
    recommendations,
    currentSessionId: currentSessionId ?? null,
  };
}

export function isActiveDeviceStatus(status: string) {
  return isDeviceCredentialActive(status);
}
