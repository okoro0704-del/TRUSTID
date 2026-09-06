import {
  AUDIT_EVENTS,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  TRUST_ID_ACCESS_LEVELS,
  type BiometricModality,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import {
  biometricTemplateHash,
  sealJson,
} from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import type { BiometricPayload } from "./schemas.js";
import { isAiVectorPayload, pgVectorMatcher } from "./vector-matcher.js";

export type BiometricMatchResult = {
  matched: boolean;
  userId?: string;
  trustId?: string;
  similarity?: number;
  distance?: number;
  templateId?: string;
  embeddingId?: string;
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
  errorCode?: string;
  error?: string;
};

function normalizeEmbedding(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/**
 * Identity-first 1:N biometric matcher.
 * Routes 512-D AI vectors to pgvector Top-K + rerank.
 * Legacy short-embedding full-gallery scans are disabled (fail closed).
 */
export class BiometricMatcherService {
  async enrollTemplate(input: {
    userId: string;
    trustId?: string;
    biometric: BiometricPayload;
    ip?: string;
    userAgent?: string;
  }) {
    if (isAiVectorPayload(input.biometric)) {
      const user = input.trustId
        ? { trustId: input.trustId }
        : await prisma.user.findUniqueOrThrow({
            where: { id: input.userId },
            select: { trustId: true },
          });
      return pgVectorMatcher.enrollEmbedding({
        userId: input.userId,
        trustId: user.trustId,
        biometric: input.biometric,
        modelName: input.biometric.modelName,
        modelVersion: input.biometric.modelVersion,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    }

    const { modality, embedding } = input.biometric;
    if (!embedding) {
      throw Object.assign(new Error("Legacy enroll requires embedding array"), {
        statusCode: 400,
      });
    }
    const normalized = normalizeEmbedding(embedding);
    const templateHash = biometricTemplateHash(modality, normalized);
    const embeddingSeal = sealJson(normalized);

    const row = await prisma.biometricTemplate.upsert({
      where: {
        userId_modality_templateHash: {
          userId: input.userId,
          modality,
          templateHash,
        },
      },
      create: {
        userId: input.userId,
        modality,
        templateHash,
        embeddingSeal,
        algorithm: "cosine-v1",
        status: "active",
      },
      update: {
        embeddingSeal,
        status: "active",
        enrolledAt: new Date(),
      },
    });

    await recordAudit({
      type: AUDIT_EVENTS.BIOMETRIC_ENROLLED,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: { modality, templateId: row.id },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { templateId: row.id, modality };
  }

  async matchOneToMany(input: {
    biometric: BiometricPayload;
    requireMasterAccess?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<BiometricMatchResult> {
    if (isAiVectorPayload(input.biometric)) {
      const ai = await pgVectorMatcher.matchOneToMany(input);
      return {
        matched: ai.matched,
        userId: ai.userId,
        trustId: ai.trustId,
        similarity: ai.similarity,
        distance: ai.distance,
        embeddingId: ai.embeddingId,
        accessLevel: ai.accessLevel,
        isMasterDevice: ai.isMasterDevice,
        errorCode: ai.errorCode,
        error: ai.error,
      };
    }

    // Legacy short-embedding path: do NOT load the full template gallery.
    return {
      matched: false,
      accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: false,
      errorCode: "BIOMETRIC_TEMPLATE_LEGACY",
      error:
        "Legacy embedding match is disabled. Use the production ArcFace 512-D pipeline.",
    };
  }
}

export const biometricMatcher = new BiometricMatcherService();

export function assertModality(m: string): asserts m is BiometricModality {
  if (m !== "face" && m !== "fingerprint") {
    throw Object.assign(new Error("Invalid biometric modality"), {
      statusCode: 400,
    });
  }
}

export { BIOMETRIC_AI_EMBEDDING_DIMS };
