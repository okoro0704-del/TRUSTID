import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_MODALITIES,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
} from "@trustid/shared";
import { config } from "../../lib/config.js";
import { clientMeta, setSessionCookie } from "../../lib/auth-context.js";
import { calculateCosineDistance } from "../../lib/vector-math.js";
import { prisma } from "../../db/client.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ambientSignInAndSession } from "./fusion.js";
import {
  cacheUserVector,
  getCachedVectorByTrustId,
} from "./vector-hot-cache.js";

export const MATCH_STRATEGIES = {
  DIRECT_1_1: "1:1_DIRECT_VERIFICATION",
  GLOBAL_1_N: "1:N_GLOBAL_SEARCH",
} as const;

export type MatchStrategy =
  (typeof MATCH_STRATEGIES)[keyof typeof MATCH_STRATEGIES];

export const fastVectorMatchSchema = z.object({
  vector: z.array(z.number()).length(BIOMETRIC_AI_EMBEDDING_DIMS).optional(),
  /** Alias used by biometric-login clients */
  faceVector: z
    .array(z.number())
    .length(BIOMETRIC_AI_EMBEDDING_DIMS)
    .optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceFingerprint: z.string().min(8).max(256).optional(),
  installId: z.string().min(1).max(80).optional(),
  /** Locally cached Trust ID from SecureStorage / remembered account */
  cachedTrustId: z.string().min(3).max(64).optional(),
  confidence: z.number().min(0).max(1).optional(),
  modelName: z.string().max(64).optional(),
  modelVersion: z.number().int().positive().optional(),
}).refine((b) => Boolean(b.vector?.length || b.faceVector?.length), {
  message: "vector or faceVector is required",
});

export type FastVectorMatchBody = z.infer<typeof fastVectorMatchSchema>;

function maxDistance(): number {
  const raw = process.env.FAST_VECTOR_MAX_DISTANCE;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return BIOMETRIC_PGVECTOR_MAX_DISTANCE;
}

function sessionBody(token: string | undefined) {
  if (config.exposeSessionTokenInBody && token) {
    return { sessionToken: token };
  }
  return {};
}

type OneToOneHit = {
  userId: string;
  trustId: string;
  embeddingId: string;
  distance: number;
  source: "memory" | "redis" | "db";
};

/**
 * PATH A ù O(1) 1:1 verify against a known Trust ID template.
 * Returns null when cache/DB miss or distance above threshold (fall through to 1:N).
 */
export async function tryDirectOneToOneVerify(input: {
  cachedTrustId: string;
  probe: number[];
}): Promise<OneToOneHit | null> {
  const threshold = maxDistance();
  const trustId = input.cachedTrustId.trim();
  if (!trustId) return null;

  let userId = "";
  let embeddingId = "";
  let target: number[] | null = null;
  let source: OneToOneHit["source"] = "memory";

  const cached = await getCachedVectorByTrustId(trustId);
  if (cached?.vector?.length) {
    target = cached.vector;
    userId = cached.userId;
    embeddingId = cached.embeddingId;
    source = cached.source;
  }

  if (!target) {
    const row = await prisma.biometricEmbedding.findFirst({
      where: {
        trustId,
        modality: BIOMETRIC_MODALITIES.FACE,
        status: "active",
      },
      select: {
        id: true,
        userId: true,
        trustId: true,
        embeddingJson: true,
      },
    });
    if (!row) return null;
    try {
      target = JSON.parse(row.embeddingJson) as number[];
    } catch {
      return null;
    }
    userId = row.userId;
    embeddingId = row.id;
    source = "db";
    void cacheUserVector({
      userId: row.userId,
      trustId: row.trustId,
      embeddingId: row.id,
      vector: target,
    });
  }

  // Redis-only hit may omit userId ù resolve from Trust ID once.
  if (!userId) {
    const user = await prisma.user.findUnique({
      where: { trustId },
      select: { id: true },
    });
    if (!user) return null;
    userId = user.id;
    if (!embeddingId) {
      const emb = await prisma.biometricEmbedding.findFirst({
        where: { userId, modality: BIOMETRIC_MODALITIES.FACE, status: "active" },
        select: { id: true },
      });
      embeddingId = emb?.id ?? userId;
    }
  }

  const distance = calculateCosineDistance(input.probe, target);
  if (distance > threshold) return null;

  return {
    userId,
    trustId,
    embeddingId,
    distance,
    source,
  };
}

/**
 * Dual-path biometric login:
 * - Path A: cachedTrustId ? 1:1 cosine (sub-5ms target)
 * - Path B: 1:N HNSW / hot-cache global search
 */
export async function handleFastVectorMatch(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const body = fastVectorMatchSchema.parse(req.body ?? {});
  const vector = (body.vector?.length ? body.vector : body.faceVector) ?? [];
  if (vector.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    return reply.code(400).send({
      error: "invalid_vector",
      message: "Valid 512-dimensional vector required.",
    });
  }

  const started = performance.now();
  const meta = clientMeta(req);
  let strategy: MatchStrategy = MATCH_STRATEGIES.GLOBAL_1_N;
  let pathDistance: number | undefined;

  // =========================================================================
  // PATH A: Ultra-fast 1:1 when this device already knows a Trust ID
  // =========================================================================
  if (body.cachedTrustId) {
    const direct = await tryDirectOneToOneVerify({
      cachedTrustId: body.cachedTrustId,
      probe: vector,
    });
    if (direct) {
      strategy = MATCH_STRATEGIES.DIRECT_1_1;
      pathDistance = direct.distance;
    }
    // Distance miss ? fall through to Path B (account switch / wrong face)
  }

  // =========================================================================
  // PATH B (or Path A session mint): ambient match + session / approval
  // After Path A verify, ambient hits hot cache ù still O(1) for known face.
  // =========================================================================
  const result = await ambientSignInAndSession({
    payload: {
      face: {
        modality: BIOMETRIC_MODALITIES.FACE,
        vector,
        confidence: body.confidence,
        modelName: body.modelName,
        modelVersion: body.modelVersion,
        deviceFingerprint: body.deviceFingerprint ?? body.deviceId,
      },
      deviceFingerprint: body.deviceFingerprint ?? body.deviceId,
    },
    allowAutoEnroll: false,
    installId: body.installId,
    ...meta,
  });

  const durationMs = performance.now() - started;

  if (!result.matched) {
    return {
      status: "NOT_FOUND" as const,
      strategy: MATCH_STRATEGIES.GLOBAL_1_N,
      durationMs,
      canRegister: true,
      message: result.error ?? "No Trust ID record matches this facial vector.",
      maxDistance: BIOMETRIC_PGVECTOR_MAX_DISTANCE,
    };
  }

  // If Path A claimed a hit but ambient matched a different Trust ID, report 1:N
  if (
    strategy === MATCH_STRATEGIES.DIRECT_1_1 &&
    body.cachedTrustId &&
    result.trustId &&
    result.trustId !== body.cachedTrustId
  ) {
    strategy = MATCH_STRATEGIES.GLOBAL_1_N;
  }

  if (result.needsMasterApproval) {
    return {
      status: "PENDING_MASTER_APPROVAL" as const,
      strategy: MATCH_STRATEGIES.GLOBAL_1_N,
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
    strategy,
    trustId: result.trustId,
    userId: result.fusion?.userId,
    distance:
      pathDistance ??
      (result.faceMatchScore != null
        ? 1 - result.faceMatchScore
        : undefined),
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

/** Alias handler name matching the biometric-login route. */
export const handleBiometricLogin = handleFastVectorMatch;
