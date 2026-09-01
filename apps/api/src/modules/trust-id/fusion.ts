import {
  AUDIT_EVENTS,
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
  matchedModality?: "face" | "fingerprint" | "both";
  isFaceMatched?: boolean;
  isFingerprintMatched?: boolean;
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
 * Single-biometric OR resolution for daily sign-in.
 * isAuthenticated = isFaceMatched || isFingerprintMatched
 *
 * Day-1 onboarding may register both templates; daily login accepts either one.
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

  const isFaceMatched =
    Boolean(faceResult?.matched) &&
    (faceResult?.similarity ?? 0) >= BIOMETRIC_SINGLE_MODALITY_THRESHOLD;
  const isFingerprintMatched =
    Boolean(fpResult?.matched) &&
    (fpResult?.similarity ?? 0) >= BIOMETRIC_SINGLE_MODALITY_THRESHOLD;

  const faceScore = isFaceMatched ? (faceResult?.similarity ?? 0) : 0;
  const fpScore = isFingerprintMatched ? (fpResult?.similarity ?? 0) : 0;

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
      matchedModality: input.payload.face ? "face" : "fingerprint",
      isFaceMatched: Boolean(input.payload.face),
      isFingerprintMatched: Boolean(input.payload.fingerprint),
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
    matchedModality: fusion.matchedModality,
    isFaceMatched: fusion.isFaceMatched,
    isFingerprintMatched: fusion.isFingerprintMatched,
  };
}
