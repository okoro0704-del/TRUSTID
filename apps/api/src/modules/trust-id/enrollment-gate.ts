/**
 * Canonical biometric enrollment integrity boundary.
 *
 * Every production path that creates a biometric identity, or attaches a face
 * template to an identity, goes through this module:
 *
 *   capture validation -> embedding validation -> duplicate candidate retrieval
 *   (pgvector Top-K + hot cache) -> exact rerank -> duplicate decision
 *   -> CLEAR ? serialized create/attach : block (409 review / 503 unavailable)
 *
 * The duplicate decision is the production one (`assessDuplicateEnrollment`),
 * and the create/attach runs inside the durable enrollment lock, so no two
 * enrollments of the same face can both observe CLEAR. Only CLEAR proceeds;
 * REVIEW_REQUIRED, AMBIGUOUS and SERVICE_UNAVAILABLE never create or attach.
 *
 * Fingerprint templates are derived from a device Keystore public key
 * (`fingerprint_keystore_v1`). They are device credentials, not a human
 * biometric, so they cannot de-duplicate people and are not face-gated.
 */
import {
  AUDIT_EVENTS,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_MODALITIES,
  isProductionArcFaceModelName,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { commitName, newTrustId } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import {
  DUPLICATE_ENROLLMENT_DECISION,
  type DuplicateEnrollmentAssessment,
} from "./duplicate-enrollment.js";
import { withBiometricEnrollmentLock } from "./enrollment-serialization.js";
import { biometricMatcher } from "./matcher.js";
import type { BiometricPayload } from "./schemas.js";
import { pgVectorMatcher } from "./vector-matcher.js";

/** Same face-presence floor ambient enrollment already applies. */
export const FACE_ENROLLMENT_MIN_CONFIDENCE = 0.5;

export type EnrollmentGateContext = {
  ip?: string;
  userAgent?: string;
};

export type NewIdentityRequest = EnrollmentGateContext & {
  face?: BiometricPayload;
  fingerprint?: BiometricPayload;
};

export type AttachTemplateRequest = EnrollmentGateContext & {
  userId: string;
  biometric: BiometricPayload;
};

function rejection(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code, errorCode: code });
}

/** Capture + embedding validation for any face that may be enrolled. */
export function validateFaceEnrollmentPayload(face: BiometricPayload | undefined): BiometricPayload {
  if (!face) {
    throw rejection("Face scan required to create a Trust ID", 400, "face_required");
  }
  if (face.modality !== BIOMETRIC_MODALITIES.FACE) {
    throw rejection("Face enrollment requires modality=face", 400, "invalid_modality");
  }
  if (face.confidence != null && face.confidence < FACE_ENROLLMENT_MIN_CONFIDENCE) {
    throw rejection(
      "No face detected. Look straight at the camera so Trust ID can verify you.",
      400,
      BIOMETRIC_ERROR_CODES.NO_FACE,
    );
  }
  const raw = face.vector ?? face.embedding;
  if (!raw || raw.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    throw rejection(
      `Face enrollment requires a ${BIOMETRIC_AI_EMBEDDING_DIMS}-D production ArcFace vector.`,
      400,
      BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
    );
  }
  if (!isProductionArcFaceModelName(face.modelName)) {
    throw rejection(
      `Face enrollment requires modelName=${BIOMETRIC_AI_MODEL_NAME}.`,
      400,
      BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
    );
  }
  if (face.modelVersion !== BIOMETRIC_AI_MODEL_VERSION) {
    throw rejection(
      `Face enrollment requires modelVersion=${BIOMETRIC_AI_MODEL_VERSION}.`,
      400,
      BIOMETRIC_ERROR_CODES.BIOMETRIC_MODEL_VERSION_MISMATCH,
    );
  }
  let sq = 0;
  for (const x of raw) {
    if (!Number.isFinite(x)) {
      throw rejection("Embedding contains non-finite values", 400, BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED);
    }
    sq += x * x;
  }
  if (!(Math.sqrt(sq) > 1e-12)) {
    throw rejection("Embedding norm must be finite and non-zero", 400, BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED);
  }
  return face;
}

/**
 * Production duplicate decision, optionally ignoring the identity that is
 * re-enrolling its own face. Any other identity passing threshold blocks.
 */
async function decideDuplicate(
  face: BiometricPayload,
  enrollingTrustId?: string,
): Promise<DuplicateEnrollmentAssessment> {
  const assessment = await pgVectorMatcher.assessDuplicateEnrollment({ biometric: face });
  if (
    enrollingTrustId &&
    assessment.decision !== DUPLICATE_ENROLLMENT_DECISION.CLEAR &&
    assessment.decision !== DUPLICATE_ENROLLMENT_DECISION.SERVICE_UNAVAILABLE &&
    assessment.candidateTrustIds.length > 0 &&
    assessment.candidateTrustIds.every((t) => t === enrollingTrustId)
  ) {
    return {
      decision: DUPLICATE_ENROLLMENT_DECISION.CLEAR,
      canAutoCreate: true,
      candidateCount: 0,
      candidateTrustIds: [],
      reason: "only_the_enrolling_identity_passed_threshold",
    };
  }
  return assessment;
}

async function blockUnlessClear(
  assessment: DuplicateEnrollmentAssessment,
  path: string,
  ctx: EnrollmentGateContext,
  userId?: string,
): Promise<void> {
  if (assessment.decision === DUPLICATE_ENROLLMENT_DECISION.CLEAR && assessment.canAutoCreate) return;
  await recordAudit({
    type: AUDIT_EVENTS.BIOMETRIC_MATCH_FAILED,
    userId,
    actorType: userId ? "user" : "system",
    actorId: userId,
    metadata: {
      reason: "duplicate_enrollment_blocked",
      path,
      decision: assessment.decision,
      candidateCount: assessment.candidateCount,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  if (assessment.decision === DUPLICATE_ENROLLMENT_DECISION.SERVICE_UNAVAILABLE) {
    throw rejection(
      "Biometric duplicate check is unavailable; enrollment failed closed.",
      503,
      BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE,
    );
  }
  throw rejection(
    "An existing Trust ID candidate requires stronger verification or account recovery before enrollment.",
    409,
    assessment.decision === DUPLICATE_ENROLLMENT_DECISION.AMBIGUOUS
      ? BIOMETRIC_ERROR_CODES.AMBIGUOUS_MATCH
      : "DUPLICATE_ENROLLMENT_REVIEW_REQUIRED",
  );
}

/** Errors without an HTTP status (database, driver, lock client) fail closed as 503. */
async function failClosed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err && typeof err === "object" && typeof (err as { statusCode?: unknown }).statusCode === "number") {
      throw err;
    }
    throw Object.assign(
      new Error("Biometric enrollment backend is unavailable; enrollment failed closed."),
      {
        statusCode: 503,
        code: BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE,
        reason: "enrollment_backend_error",
        cause: err,
      },
    );
  }
}

/**
 * Create a new biometric identity. Face is mandatory; it must pass the
 * duplicate gate. The identity and its templates are written inside the
 * enrollment lock; if a template write fails, the new identity is removed
 * before the lock is released so no identity exists without its face.
 */
export async function createBiometricIdentity(input: NewIdentityRequest) {
  const face = validateFaceEnrollmentPayload(input.face);
  return failClosed(() =>
    withBiometricEnrollmentLock(async () => {
      await blockUnlessClear(await decideDuplicate(face), "create_identity", input);

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

      try {
        await biometricMatcher.enrollTemplate({
          userId: user.id,
          trustId: user.trustId,
          biometric: face,
          ip: input.ip,
          userAgent: input.userAgent,
        });
        if (input.fingerprint) {
          await biometricMatcher.enrollTemplate({
            userId: user.id,
            trustId: user.trustId,
            biometric: input.fingerprint,
            ip: input.ip,
            userAgent: input.userAgent,
          });
        }
      } catch (err) {
        await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
        throw err;
      }
      return { user, trustId };
    }),
  );
}

/**
 * Attach a template to an existing identity (POST /v1/trust-id/enroll-biometric).
 * Faces pass the same duplicate gate under the same lock as identity creation;
 * a face that already belongs to another identity is refused.
 */
export async function attachBiometricTemplate(input: AttachTemplateRequest) {
  if (input.biometric.modality !== BIOMETRIC_MODALITIES.FACE) {
    return biometricMatcher.enrollTemplate({
      userId: input.userId,
      biometric: input.biometric,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }
  const face = validateFaceEnrollmentPayload(input.biometric);
  return failClosed(() =>
    withBiometricEnrollmentLock(async () => {
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: input.userId },
        select: { trustId: true },
      });
      await blockUnlessClear(
        await decideDuplicate(face, owner.trustId),
        "attach_face_template",
        input,
        input.userId,
      );
      return biometricMatcher.enrollTemplate({
        userId: input.userId,
        trustId: owner.trustId,
        biometric: face,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    }),
  );
}
