import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_MODALITIES,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
} from "@trustid/shared";
import { config } from "../../lib/config.js";
import { clientMeta, setSessionCookie } from "../../lib/auth-context.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ambientSignInAndSession } from "./fusion.js";

export const fastVectorMatchSchema = z.object({
  vector: z.array(z.number()).length(BIOMETRIC_AI_EMBEDDING_DIMS),
  /** Optional alias used by some clients */
  faceVector: z.array(z.number()).length(BIOMETRIC_AI_EMBEDDING_DIMS).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceFingerprint: z.string().min(8).max(256).optional(),
  installId: z.string().min(1).max(80).optional(),
  confidence: z.number().min(0).max(1).optional(),
  modelName: z.string().max(64).optional(),
  modelVersion: z.number().int().positive().optional(),
});

export type FastVectorMatchBody = z.infer<typeof fastVectorMatchSchema>;

function sessionBody(token: string | undefined) {
  if (config.exposeSessionTokenInBody && token) {
    return { sessionToken: token };
  }
  return {};
}

/**
 * Ultra-fast edge-vector login: accepts ONLY a 512-D float payload (~2KB).
 * Matching uses hot-cache ? HNSW cascade inside ambientSignInAndSession.
 */
export async function handleFastVectorMatch(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const body = fastVectorMatchSchema.parse(req.body ?? {});
  const vector = body.vector.length
    ? body.vector
    : body.faceVector;
  if (!vector || vector.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    return reply.code(400).send({
      error: "invalid_vector",
      message: "Invalid 512-dimensional vector payload.",
    });
  }

  const started = performance.now();
  const meta = clientMeta(req);

  const result = await ambientSignInAndSession({
    payload: {
      face: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector,
        confidence: body.confidence,
        modelName: body.modelName,
        modelVersion: body.modelVersion,
        deviceFingerprint: body.deviceFingerprint,
      },
      deviceFingerprint: body.deviceFingerprint,
    },
    allowAutoEnroll: false,
    installId: body.installId,
    ...meta,
  });

  const durationMs = performance.now() - started;

  if (!result.matched) {
    return {
      status: "NOT_FOUND" as const,
      durationMs,
      canRegister: true,
      message: result.error ?? "No Trust ID record matches this facial vector.",
      maxDistance: BIOMETRIC_PGVECTOR_MAX_DISTANCE,
    };
  }

  if (result.needsMasterApproval) {
    return {
      status: "PENDING_MASTER_APPROVAL" as const,
      trustId: result.trustId,
      approvalPollToken: result.approvalPollToken,
      approvalRequestId: result.approvalRequestId,
      durationMs,
    };
  }

  if (result.sessionToken) {
    setSessionCookie(reply, result.sessionToken);
  }

  return {
    status: "MATCH_FOUND" as const,
    trustId: result.trustId,
    userId: result.fusion?.userId,
    user: result.trustId
      ? { trustId: result.trustId, displayName: result.trustId }
      : undefined,
    identity: result.identity,
    isMasterDevice: result.isMasterDevice,
    durationMs,
    ...sessionBody(result.sessionToken),
    token: config.exposeSessionTokenInBody ? result.sessionToken : undefined,
  };
}
