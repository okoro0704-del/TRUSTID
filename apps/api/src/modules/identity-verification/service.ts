import {
  AUDIT_EVENTS,
  IDENTITY_STATUS,
  IDENTITY_VERIFICATION_STATUS,
  VERIFICATION_LEVELS,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { recordAudit } from "../audit/service.js";
import type { IdentityVerificationProvider } from "./types.js";
import { NoopIdentityVerificationProvider } from "./noop-provider.js";
import { MockIdentityVerificationProvider } from "./mock-provider.js";
import {
  issueVerifiedPortrait,
  markPortraitPending,
  rejectPortrait,
} from "../verified-identity/portrait.js";
import { bumpProfileVersion, ensureVerifiedIdentityProfile } from "../verified-identity/profile.js";

let provider: IdentityVerificationProvider = selectDefaultProvider();

function selectDefaultProvider(): IdentityVerificationProvider {
  const mode = (process.env.IDENTITY_VERIFICATION_MODE || "").toLowerCase();
  if (mode === "mock" || (mode !== "noop" && config.isDev)) {
    return new MockIdentityVerificationProvider();
  }
  return new NoopIdentityVerificationProvider();
}

/** Swap in a real provider later (e.g. NIBSS) without redesigning device auth. */
export function setIdentityVerificationProvider(next: IdentityVerificationProvider) {
  provider = next;
}

export function getIdentityVerificationProvider() {
  return provider;
}

export async function getIdentityVerificationSummary(userId: string) {
  const latest = await prisma.identityVerification.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) {
    return {
      status: IDENTITY_VERIFICATION_STATUS.NOT_VERIFIED,
      provider: null,
      method: null,
      verifiedAt: null,
      isMock: false,
    };
  }

  return {
    status: latest.status,
    provider: latest.provider,
    method: latest.method,
    verifiedAt: latest.verifiedAt?.toISOString() ?? null,
    isMock: latest.isMock,
    disclaimer: latest.isMock
      ? "Mock verification only — not real government or document identity verification."
      : undefined,
  };
}

export async function startIdentityVerification(input: {
  userId: string;
  method?: string;
  portraitId: string;
  ip?: string;
  userAgent?: string;
}) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  await ensureVerifiedIdentityProfile(input.userId);
  await markPortraitPending(input.userId, input.portraitId);

  const method = input.method || "portrait_liveness_mock";
  const started = await provider.beginVerification({
    userId: input.userId,
    trustId: user.trustId,
    method,
    metadata: { portraitId: input.portraitId },
  });

  const row = await prisma.identityVerification.create({
    data: {
      userId: input.userId,
      provider: provider.name,
      method,
      status: IDENTITY_VERIFICATION_STATUS.PENDING,
      providerReference: started.providerReference ?? started.verificationId,
      portraitId: input.portraitId,
      isMock: provider.name.startsWith("mock"),
      metadata: JSON.stringify({
        providerVerificationId: started.verificationId,
        isMock: provider.name.startsWith("mock"),
      }),
    },
  });

  await bumpProfileVersion(input.userId, {
    identityStatus: IDENTITY_STATUS.PENDING,
  });

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_VERIFICATION_STARTED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      verificationId: row.id,
      provider: provider.name,
      method,
      isMock: row.isMock,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    verificationId: row.id,
    status: row.status,
    provider: row.provider,
    method: row.method,
    isMock: row.isMock,
    portraitId: input.portraitId,
    disclaimer: row.isMock
      ? "Development mock only. This does NOT constitute real identity verification."
      : "Complete verification with the configured provider.",
  };
}

export async function completeIdentityVerification(input: {
  userId: string;
  verificationId: string;
  providerPayload?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}) {
  const row = await prisma.identityVerification.findFirst({
    where: { id: input.verificationId, userId: input.userId },
  });
  if (!row) {
    throw Object.assign(new Error("Verification not found"), {
      statusCode: 404,
      code: "not_found",
    });
  }
  if (row.status === IDENTITY_VERIFICATION_STATUS.VERIFIED) {
    throw Object.assign(new Error("Already verified"), {
      statusCode: 409,
      code: "conflict",
    });
  }
  if (!row.portraitId) {
    throw Object.assign(new Error("verification_required"), {
      statusCode: 400,
      code: "verification_required",
    });
  }

  let result;
  try {
    result = await provider.completeVerification({
      userId: input.userId,
      verificationId: row.providerReference || row.id,
      providerPayload: input.providerPayload,
    });
  } catch (err) {
    await prisma.identityVerification.update({
      where: { id: row.id },
      data: { status: IDENTITY_VERIFICATION_STATUS.FAILED },
    });
    await rejectPortrait({
      userId: input.userId,
      portraitId: row.portraitId,
      reason: "verification_failed",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await recordAudit({
      type: AUDIT_EVENTS.IDENTITY_VERIFICATION_FAILED,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: {
        verificationId: row.id,
        reason: err instanceof Error ? err.message : "failed",
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw Object.assign(new Error("Verification failed"), {
      statusCode: 400,
      code: "verification_failed",
    });
  }

  if (result.status !== IDENTITY_VERIFICATION_STATUS.VERIFIED) {
    await prisma.identityVerification.update({
      where: { id: row.id },
      data: { status: result.status },
    });
    if (result.status === IDENTITY_VERIFICATION_STATUS.FAILED) {
      await rejectPortrait({
        userId: input.userId,
        portraitId: row.portraitId,
        reason: "provider_failed",
        ip: input.ip,
        userAgent: input.userAgent,
      });
    }
    throw Object.assign(new Error("Verification pending or failed"), {
      statusCode: 400,
      code:
        result.status === IDENTITY_VERIFICATION_STATUS.PENDING
          ? "verification_pending"
          : "verification_failed",
    });
  }

  const isMock = row.isMock || provider.name.startsWith("mock");
  await prisma.identityVerification.update({
    where: { id: row.id },
    data: {
      status: IDENTITY_VERIFICATION_STATUS.VERIFIED,
      verifiedAt: result.verifiedAt ?? new Date(),
      verificationHash: result.verificationHash ?? null,
      isMock,
    },
  });

  await issueVerifiedPortrait({
    userId: input.userId,
    portraitId: row.portraitId,
    verificationMethod: row.method,
    verificationLevel: isMock
      ? VERIFICATION_LEVELS.MOCK
      : VERIFICATION_LEVELS.DOCUMENT,
    isMock,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_VERIFIED,
    userId: input.userId,
    actorType: "system",
    actorId: input.userId,
    metadata: {
      verificationId: row.id,
      isMock,
      kind: "identity_portrait_verification",
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    status: IDENTITY_VERIFICATION_STATUS.VERIFIED,
    isMock,
    verificationId: row.id,
    disclaimer: isMock
      ? "Mock verification recorded. Not real identity verification. Not production-ready."
      : "Identity verification recorded.",
  };
}
