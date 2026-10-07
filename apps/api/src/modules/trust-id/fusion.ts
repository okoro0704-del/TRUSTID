import {
  AUDIT_EVENTS,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
  BIOMETRIC_SINGLE_MODALITY_THRESHOLD,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
  TRUST_ID_ACCESS_LEVELS,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { deviceFingerprintHash } from "../../lib/crypto.js";
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
import { createBiometricIdentity } from "./enrollment-gate.js";
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
  errorCode?: string;
  error?: string;
  /**
   * True only when every presented modality was searched and genuinely not
   * found (no error, or NO_MATCH). False for service outages, model or
   * template mismatches, gated thresholds and modality conflicts: none of
   * those may create an identity.
   */
  genuineNoMatch?: boolean;
};

/** The most telling error: an infrastructure/policy code wins over NO_MATCH. */
function firstFailureCode(...results: Array<BiometricMatchResult | null>): string | undefined {
  const codes = results.map((r) => r?.errorCode).filter((c): c is string => Boolean(c));
  return codes.find((c) => c !== BIOMETRIC_ERROR_CODES.NO_MATCH) ?? codes[0];
}

/** A modality result that is a real "not enrolled", not an infrastructure or policy failure. */
function isGenuineNoMatch(result: BiometricMatchResult | null): boolean {
  if (!result) return true; // modality not presented
  if (result.matched) return false;
  return !result.errorCode || result.errorCode === BIOMETRIC_ERROR_CODES.NO_MATCH;
}

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
        faceErrorCode: faceResult?.errorCode,
        fingerprintErrorCode: fpResult?.errorCode,
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
      errorCode: firstFailureCode(faceResult, fpResult),
      error: faceResult?.error ?? fpResult?.error,
      genuineNoMatch: isGenuineNoMatch(faceResult) && isGenuineNoMatch(fpResult),
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

type AutoEnrollInput = {
  payload: MultiModalPayload;
  installId?: string;
  ip?: string;
  userAgent?: string;
};

/** Zero-UI auto-enroll: create Trust ID + enroll captured template(s). */
export async function autoEnrollFromBiometrics(input: AutoEnrollInput) {
  if (input.installId) {
    await assertInstallAvailableForNewTrustId(input.installId);
  }

  const { user, trustId } = await createBiometricIdentity({
    face: input.payload.face,
    fingerprint: input.payload.fingerprint,
    ip: input.ip,
    userAgent: input.userAgent,
  });

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

  // Explicit MasterDevice row (isMasterDevice: true) for approval + elevated ops.
  const fingerprintSeed =
    input.payload.deviceFingerprint ||
    input.payload.face?.deviceFingerprint ||
    input.installId ||
    masterDevice.id;
  const { registerMasterDevice } = await import("./master-device.js");
  const { createHash } = await import("node:crypto");
  await registerMasterDevice({
    userId: user.id,
    deviceFingerprint: fingerprintSeed,
    publicKey: createHash("sha256")
      .update(`trustid-master-bind:${fingerprintSeed}`)
      .digest("base64url"),
    deviceId: masterDevice.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await recordAudit({
    type: AUDIT_EVENTS.AMBIENT_SIGNIN_ENROLLED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: { trustId, mode: "ambient_auto_enroll", isMasterDevice: true },
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
  // Face is required to mint a new Trust ID. Login may use fingerprint alone
  // (cloud template match) when face capture fails or is not recognized.
  const hasFace = Boolean(
    input.payload.face?.vector || input.payload.face?.embedding,
  );
  const hasFingerprint = Boolean(
    input.payload.fingerprint?.vector ||
      input.payload.fingerprint?.embedding,
  );
  if (!hasFace && !hasFingerprint) {
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

  // Only a genuine "not enrolled" may create a Trust ID. A matcher outage,
  // model/template mismatch, gated threshold or modality conflict must fail
  // closed: auto-enrolling then would mint a duplicate identity for an
  // existing person.
  if (!fusion.matched && input.allowAutoEnroll && fusion.genuineNoMatch !== true) {
    return {
      matched: false as const,
      fusion,
      error: fusion.error,
      errorCode: fusion.errorCode,
    };
  }

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
      accessLevel: TRUST_ID_ACCESS_LEVELS.MASTER,
      isMasterDevice: true,
    };
    enrolled = true;
    (fusion as { _deviceId?: string })._deviceId = created.deviceId;
  }

  if (!fusion.matched || !fusion.userId || !fusion.trustId) {
    return {
      matched: false as const,
      fusion,
      error: fusion.error,
      errorCode: fusion.errorCode,
    };
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
    // Fail closed: identity assurance on an unknown device is not session
    // authorization. Approval infrastructure failure never mints a session.
    await recordAudit({
      type: AUDIT_EVENTS.AMBIENT_SIGNIN_FAILED,
      userId: fusion.userId,
      actorType: "system",
      metadata: {
        reason: "master_approval_unavailable",
        matchedModality: fusion.matchedModality,
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      matched: true as const,
      enrolled: false,
      fusion,
      trustId: fusion.trustId,
      accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: false,
      needsMasterApproval: true,
      approvalUnavailable: true,
      offerSaveDeviceKey: false,
      fusionScore: fusion.fusionScore,
      faceMatchScore: fusion.faceMatchScore,
      fingerprintMatchScore: fusion.fingerprintMatchScore,
      matchedModality: fusion.matchedModality,
      isFaceMatched: fusion.isFaceMatched,
      isFingerprintMatched: fusion.isFingerprintMatched,
      error:
        err instanceof Error
          ? `Master approval unavailable: ${err.message}`
          : "Master approval unavailable",
    };
  }
}
