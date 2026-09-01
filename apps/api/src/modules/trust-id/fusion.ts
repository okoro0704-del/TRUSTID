import {
  AUDIT_EVENTS,
  BIOMETRIC_FUSION_THRESHOLD,
  BIOMETRIC_SINGLE_MODALITY_THRESHOLD,
  TRUST_ID_ACCESS_LEVELS,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { commitName, deviceFingerprintHash, newTrustId } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { assertInstallAvailableForNewTrustId } from "../authentication/device-install.js";
import { getDashboardIdentity } from "../identity/service.js";
import { createSession } from "../sessions/service.js";
import { biometricMatcher } from "./matcher.js";
import type { BiometricPayload } from "./schemas.js";

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
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
};

async function evaluateMaster(userId: string, deviceFingerprint?: string) {
  if (!deviceFingerprint) return false;
  const hash = deviceFingerprintHash(deviceFingerprint);
  const row = await prisma.masterDevice.findFirst({
    where: { userId, deviceFingerprint: hash, isMasterDevice: true, status: "active" },
  });
  return Boolean(row);
}

/**
 * 1:N multi-vector fusion — parallel face + fingerprint matching.
 * fusionScore = faceMatchScore + fingerprintMatchScore
 */
export async function matchMultiModalFusion(input: {
  payload: MultiModalPayload;
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

  const faceScore = faceResult?.matched ? (faceResult.similarity ?? 0) : 0;
  const fpScore = fpResult?.matched ? (fpResult.similarity ?? 0) : 0;

  let userId: string | undefined;
  let trustId: string | undefined;
  let fusionScore = 0;
  let matched = false;

  if (faceResult?.matched && fpResult?.matched) {
    if (faceResult.userId !== fpResult.userId) {
      await recordAudit({
        type: AUDIT_EVENTS.AMBIENT_SIGNIN_FAILED,
        actorType: "system",
        metadata: { reason: "modality_conflict" },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        faceMatchScore: faceScore,
        fingerprintMatchScore: fpScore,
        fusionScore: faceScore + fpScore,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
      };
    }
    fusionScore = faceScore + fpScore;
    matched = fusionScore >= BIOMETRIC_FUSION_THRESHOLD;
    userId = faceResult.userId;
    trustId = faceResult.trustId;
  } else if (faceResult?.matched) {
    fusionScore = faceScore;
    matched = faceScore >= BIOMETRIC_SINGLE_MODALITY_THRESHOLD;
    userId = faceResult.userId;
    trustId = faceResult.trustId;
  } else if (fpResult?.matched) {
    fusionScore = fpScore;
    matched = fpScore >= BIOMETRIC_SINGLE_MODALITY_THRESHOLD;
    userId = fpResult.userId;
    trustId = fpResult.trustId;
  }

  if (!matched || !userId || !trustId) {
    await recordAudit({
      type: AUDIT_EVENTS.AMBIENT_SIGNIN_FAILED,
      actorType: "system",
      metadata: {
        faceMatchScore: faceScore,
        fingerprintMatchScore: fpScore,
        fusionScore,
        reason: "below_threshold",
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      matched: false,
      faceMatchScore: faceScore,
      fingerprintMatchScore: fpScore,
      fusionScore,
      accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: false,
    };
  }

  const isMasterDevice = await evaluateMaster(userId, fp);
  const accessLevel = isMasterDevice
    ? TRUST_ID_ACCESS_LEVELS.MASTER
    : TRUST_ID_ACCESS_LEVELS.UNIVERSAL;

  await recordAudit({
    type: AUDIT_EVENTS.AMBIENT_SIGNIN_MATCHED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: {
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
    accessLevel,
    isMasterDevice,
  };
}

/** Zero-UI auto-enroll: create Trust ID + enroll multi-modal templates. */
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
      biometric: input.payload.face,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }
  if (input.payload.fingerprint) {
    await biometricMatcher.enrollTemplate({
      userId: user.id,
      biometric: input.payload.fingerprint,
      ip: input.ip,
      userAgent: input.userAgent,
    });
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

  return { userId: user.id, trustId };
}

export async function ambientSignInAndSession(input: {
  payload: MultiModalPayload;
  allowAutoEnroll?: boolean;
  installId?: string;
  ip?: string;
  userAgent?: string;
}) {
  let fusion = await matchMultiModalFusion({
    payload: input.payload,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  let enrolled = false;

  if (!fusion.matched && input.allowAutoEnroll) {
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
      accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: false,
    };
    enrolled = true;
  }

  if (!fusion.matched || !fusion.userId || !fusion.trustId) {
    return { matched: false as const, fusion };
  }

  const identity = await getDashboardIdentity(fusion.userId);
  const { token } = await createSession({
    userId: fusion.userId,
    kind: enrolled ? "ambient_enroll" : fusion.isMasterDevice ? "master" : "ambient",
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    matched: true as const,
    enrolled,
    fusion,
    sessionToken: token,
    identity,
    trustId: fusion.trustId,
    accessLevel: fusion.accessLevel,
    isMasterDevice: fusion.isMasterDevice,
    fusionScore: fusion.fusionScore,
    faceMatchScore: fusion.faceMatchScore,
    fingerprintMatchScore: fusion.fingerprintMatchScore,
  };
}
