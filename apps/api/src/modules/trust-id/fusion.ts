import {
  AUDIT_EVENTS,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
  BIOMETRIC_SINGLE_MODALITY_THRESHOLD,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  TRUST_ID_ACCESS_LEVELS,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { commitName, deviceFingerprintHash, newTrustId } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import {
  assertInstallAvailableForNewTrustId,
  bindInstallToUser,
  getInstallOccupancy,
} from "../authentication/device-install.js";
import { getDashboardIdentity } from "../identity/service.js";
import { createSession } from "../sessions/service.js";
import { biometricMatcher } from "./matcher.js";
import type { BiometricMatchResult } from "./matcher.js";
import type { BiometricPayload } from "./schemas.js";
import { isAiVectorPayload } from "./vector-matcher.js";

export type MultiModalPayload = {
  face?: BiometricPayload;
  fingerprint?: BiometricPayload;
  deviceFingerprint?: string;
};

export type FusionMatchResult = {
  matched: boolean;
  userId?: string;
  trustId?: string;
  fusionScore?: number;
  faceMatchScore?: number;
  fingerprintMatchScore?: number;
  matchedModality?: "face" | "fingerprint" | "both";
  isFaceMatched?: boolean;
  isFingerprintMatched?: boolean;
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
};

async function evaluateMaster(
  userId: string,
  deviceFingerprint?: string,
  installId?: string,
) {
  if (deviceFingerprint) {
    const hash = deviceFingerprintHash(deviceFingerprint);
    const row = await prisma.masterDevice.findFirst({
      where: {
        userId,
        deviceFingerprint: hash,
        isMasterDevice: true,
        status: "active",
      },
    });
    if (row) return true;
  }
  // Same phone / APK install that already owns this Trust ID is the master terminal.
  if (installId) {
    try {
      const occ = await getInstallOccupancy(installId);
      if (occ.occupied && occ.userId === userId) return true;
    } catch {
      /* invalid install id — ignore */
    }
  }
  return false;
}

function modalityMatched(
  result: BiometricMatchResult | null,
  payload?: BiometricPayload,
): boolean {
  if (!result?.matched) return false;
  if (payload && isAiVectorPayload(payload)) return true;
  return (result.similarity ?? 0) >= BIOMETRIC_SINGLE_MODALITY_THRESHOLD;
}

function modalityScore(result: BiometricMatchResult | null, payload?: BiometricPayload): number {
  if (!result?.matched) return 0;
  if (payload && isAiVectorPayload(payload)) {
    return result.distance != null
      ? Math.max(0, 1 - result.distance / BIOMETRIC_PGVECTOR_MAX_DISTANCE)
      : (result.similarity ?? 0);
  }
  return result.similarity ?? 0;
}

/**
 * Single-biometric OR resolution for daily sign-in.
 * isAuthenticated = isFaceMatched || isFingerprintMatched
 *
 * Day-1 onboarding may register both templates; daily login accepts either one.
 */
export async function matchMultiModalFusion(input: {
  payload: MultiModalPayload;
  installId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<FusionMatchResult> {
  const { face, fingerprint, deviceFingerprint } = input.payload;
  const fp = deviceFingerprint ?? face?.deviceFingerprint ?? fingerprint?.deviceFingerprint;

  const [faceResult, fpResult] = await Promise.all([
    face
      ? biometricMatcher.matchOneToMany({
          biometric: { ...face, deviceFingerprint: fp },
          ip: input.ip,
          userAgent: input.userAgent,
        })
      : Promise.resolve(null),
    fingerprint
      ? biometricMatcher.matchOneToMany({
          biometric: { ...fingerprint, deviceFingerprint: fp },
          ip: input.ip,
          userAgent: input.userAgent,
        })
      : Promise.resolve(null),
  ]);

  const isFaceMatched = modalityMatched(faceResult, face);
  const isFingerprintMatched = modalityMatched(fpResult, fingerprint);

  const faceScore = modalityScore(faceResult, face);
  const fpScore = modalityScore(fpResult, fingerprint);

  if (isFaceMatched && isFingerprintMatched) {
    if (faceResult!.userId !== fpResult!.userId) {
      await recordAudit({
        type: AUDIT_EVENTS.AMBIENT_SIGNIN_FAILED,
        actorType: "system",
        metadata: { reason: "modality_conflict" },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        isFaceMatched,
        isFingerprintMatched,
        faceMatchScore: faceScore,
        fingerprintMatchScore: fpScore,
        fusionScore: faceScore + fpScore,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
      };
    }
  }

  const matched = isFaceMatched || isFingerprintMatched;
  if (!matched) {
    await recordAudit({
      type: AUDIT_EVENTS.AMBIENT_SIGNIN_FAILED,
      actorType: "system",
      metadata: {
        faceMatchScore: faceScore,
        fingerprintMatchScore: fpScore,
        reason: "no_single_modality_match",
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      matched: false,
      isFaceMatched,
      isFingerprintMatched,
      faceMatchScore: faceScore,
      fingerprintMatchScore: fpScore,
      accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: false,
    };
  }

  const winner = isFaceMatched ? faceResult! : fpResult!;
  const matchedModality: FusionMatchResult["matchedModality"] =
    isFaceMatched && isFingerprintMatched
      ? "both"
      : isFaceMatched
        ? "face"
        : "fingerprint";

  const userId = winner.userId!;
  const trustId = winner.trustId!;
  const fusionScore = faceScore + fpScore;

  const isMasterDevice = await evaluateMaster(userId, fp, input.installId);
  const accessLevel = isMasterDevice
    ? TRUST_ID_ACCESS_LEVELS.MASTER
    : TRUST_ID_ACCESS_LEVELS.UNIVERSAL;

  await recordAudit({
    type: AUDIT_EVENTS.AMBIENT_SIGNIN_MATCHED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: {
      matchedModality,
      isFaceMatched,
      isFingerprintMatched,
      fusionScore,
      faceMatchScore: faceScore,
      fingerprintMatchScore: fpScore,
      accessLevel,
      isMasterDevice,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    matched: true,
    userId,
    trustId,
    fusionScore,
    faceMatchScore: faceScore,
    fingerprintMatchScore: fpScore,
    matchedModality,
    isFaceMatched,
    isFingerprintMatched,
    accessLevel,
    isMasterDevice,
  };
}

/** Zero-UI auto-enroll: create Trust ID + enroll captured template(s). */
export async function autoEnrollFromBiometrics(input: {
  payload: MultiModalPayload;
  installId?: string;
  ip?: string;
  userAgent?: string;
}) {
  if (input.installId) {
    await assertInstallAvailableForNewTrustId(input.installId);
  }

  let trustId = newTrustId();
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.user.findUnique({ where: { trustId } });
    if (!clash) break;
    trustId = newTrustId();
  }

  const nameCommit = commitName("Trust", "ID");
  const user = await prisma.user.create({
    data: {
      trustId,
      status: "active",
      profile: {
        create: {
          nameCommitment: nameCommit.nameCommitment,
          nameSalt: nameCommit.nameSalt,
        },
      },
    },
  });

  if (input.payload.face) {
    await biometricMatcher.enrollTemplate({
      userId: user.id,
      trustId: user.trustId,
      biometric: input.payload.face,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }
  if (input.payload.fingerprint) {
    await biometricMatcher.enrollTemplate({
      userId: user.id,
      trustId: user.trustId,
      biometric: input.payload.fingerprint,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  // First terminal becomes Primary / Master so later devices can request approval.
  const masterDevice = await prisma.device.create({
    data: {
      userId: user.id,
      name: "Master device",
      status: DEVICE_STATUS.ACTIVE,
      trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      userAgent: input.userAgent ?? null,
      lastIp: input.ip ?? null,
      lastActiveAt: new Date(),
    },
  });

  if (input.installId) {
    await bindInstallToUser(input.installId, user.id);
  }

  await recordAudit({
    type: AUDIT_EVENTS.AMBIENT_SIGNIN_ENROLLED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: { trustId, mode: "ambient_auto_enroll" },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { userId: user.id, trustId, deviceId: masterDevice.id };
}

export async function ambientSignInAndSession(input: {
  payload: MultiModalPayload;
  allowAutoEnroll?: boolean;
  installId?: string;
  ip?: string;
  userAgent?: string;
}) {
  // Face is mandatory for ambient identity — fingerprint alone cannot mint or match.
  const hasFace = Boolean(
    input.payload.face?.vector || input.payload.face?.embedding,
  );
  if (!hasFace) {
    return {
      matched: false as const,
      fusion: {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
      },
      error:
        "No face detected. Look straight at the camera so Trust ID can verify you.",
    };
  }

  let fusion = await matchMultiModalFusion({
    payload: input.payload,
    installId: input.installId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  let enrolled = false;

  // Refuse to mint a Trust ID from a blank / no-face camera frame.
  const faceConfidence = input.payload.face?.confidence;
  const faceOk =
    hasFace && (faceConfidence == null || faceConfidence >= 0.5);

  if (!fusion.matched && input.allowAutoEnroll) {
    if (!faceOk) {
      return {
        matched: false as const,
        fusion,
        error:
          "No face detected. Look straight at the camera so Trust ID can verify you.",
      };
    }

    // Same phone already bound to someone — do not silently create a second identity.
    if (input.installId) {
      try {
        const occ = await getInstallOccupancy(input.installId);
        if (occ.occupied) {
          return {
            matched: false as const,
            fusion,
            error: `Face not recognized as ${occ.trustId}. Position the correct face, or clear this device to enroll a new Trust ID.`,
          };
        }
      } catch {
        /* invalid install id — continue */
      }
    }

    const created = await autoEnrollFromBiometrics({
      payload: input.payload,
      installId: input.installId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    fusion = {
      matched: true,
      userId: created.userId,
      trustId: created.trustId,
      fusionScore: 1,
      matchedModality: "face",
      isFaceMatched: true,
      isFingerprintMatched: Boolean(input.payload.fingerprint),
      accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: false,
    };
    enrolled = true;
    (fusion as { _deviceId?: string })._deviceId = created.deviceId;
  }

  if (!fusion.matched || !fusion.userId || !fusion.trustId) {
    return { matched: false as const, fusion };
  }

  async function resolvePrimaryDeviceId(userId: string) {
    const primary = await prisma.device.findFirst({
      where: {
        userId,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
        status: { in: [DEVICE_STATUS.ACTIVE, DEVICE_STATUS.TRUSTED] },
      },
      orderBy: { trustedAt: "asc" },
    });
    return primary?.id ?? null;
  }

  // First-time cloud enroll: this terminal becomes the account's primary/master.
  if (enrolled) {
    const deviceId =
      (fusion as { _deviceId?: string })._deviceId ??
      (await resolvePrimaryDeviceId(fusion.userId));
    const identity = await getDashboardIdentity(fusion.userId);
    const { token } = await createSession({
      userId: fusion.userId,
      deviceId,
      kind: "ambient_enroll",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      matched: true as const,
      enrolled: true,
      fusion,
      sessionToken: token,
      identity,
      trustId: fusion.trustId,
      accessLevel: fusion.accessLevel,
      isMasterDevice: true,
      offerSaveDeviceKey: true,
      fusionScore: fusion.fusionScore,
      faceMatchScore: fusion.faceMatchScore,
      fingerprintMatchScore: fusion.fingerprintMatchScore,
      matchedModality: fusion.matchedModality,
      isFaceMatched: fusion.isFaceMatched,
      isFingerprintMatched: fusion.isFingerprintMatched,
    };
  }

  // Returning identity: master / already-bound terminal gets a session immediately.
  if (fusion.isMasterDevice) {
    const deviceId = await resolvePrimaryDeviceId(fusion.userId);
    const identity = await getDashboardIdentity(fusion.userId);
    const { token } = await createSession({
      userId: fusion.userId,
      deviceId,
      kind: "master",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      matched: true as const,
      enrolled: false,
      fusion,
      sessionToken: token,
      identity,
      trustId: fusion.trustId,
      accessLevel: TRUST_ID_ACCESS_LEVELS.MASTER,
      isMasterDevice: true,
      fusionScore: fusion.fusionScore,
      faceMatchScore: fusion.faceMatchScore,
      fingerprintMatchScore: fusion.fingerprintMatchScore,
      matchedModality: fusion.matchedModality,
      isFaceMatched: fusion.isFaceMatched,
      isFingerprintMatched: fusion.isFingerprintMatched,
    };
  }

  // New terminal for an existing Trust ID → notify Master Device (no session yet).
  const { createDeviceApprovalRequest } = await import(
    "../device-approval/service.js"
  );
  try {
    const approval = await createDeviceApprovalRequest({
      trustId: fusion.trustId,
      deviceName: "TrustID terminal",
      applicationName: "TrustID",
      // Persist secondary install so TRUST can bind it and skip future prompts.
      guestSessionId: input.installId,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      matched: true as const,
      enrolled: false,
      fusion,
      trustId: fusion.trustId,
      accessLevel: fusion.accessLevel,
      isMasterDevice: false,
      needsMasterApproval: true,
      approvalPollToken: approval.pollToken,
      approvalRequestId: approval.requestId,
      offerSaveDeviceKey: true,
      fusionScore: fusion.fusionScore,
      faceMatchScore: fusion.faceMatchScore,
      fingerprintMatchScore: fusion.fingerprintMatchScore,
      matchedModality: fusion.matchedModality,
      isFaceMatched: fusion.isFaceMatched,
      isFingerprintMatched: fusion.isFingerprintMatched,
    };
  } catch (err) {
    // No primary device yet (legacy accounts) — allow ambient session once.
    const identity = await getDashboardIdentity(fusion.userId);
    const { token } = await createSession({
      userId: fusion.userId,
      kind: "ambient",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      matched: true as const,
      enrolled: false,
      fusion,
      sessionToken: token,
      identity,
      trustId: fusion.trustId,
      accessLevel: fusion.accessLevel,
      isMasterDevice: false,
      offerSaveDeviceKey: true,
      fusionScore: fusion.fusionScore,
      faceMatchScore: fusion.faceMatchScore,
      fingerprintMatchScore: fusion.fingerprintMatchScore,
      matchedModality: fusion.matchedModality,
      isFaceMatched: fusion.isFaceMatched,
      isFingerprintMatched: fusion.isFingerprintMatched,
      error:
        err instanceof Error
          ? `Master approval unavailable: ${err.message}`
          : undefined,
    };
  }
}
