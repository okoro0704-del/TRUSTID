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
  deviceFingerprintHash,
  openJson,
  sealJson,
} from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import type { BiometricPayload } from "./schemas.js";
import { isAiVectorPayload, pgVectorMatcher } from "./vector-matcher.js";

/** Legacy cosine similarity threshold for short embeddings */
const LEGACY_MATCH_THRESHOLD = 0.82;

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
};

function normalizeEmbedding(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot;
}

async function isMasterTerminal(userId: string, deviceFingerprint?: string) {
  if (!deviceFingerprint) return false;
  const hash = deviceFingerprintHash(deviceFingerprint);
  const row = await prisma.masterDevice.findFirst({
    where: {
      userId,
      deviceFingerprint: hash,
      isMasterDevice: true,
      status: "active",
    },
  });
  return Boolean(row);
}

/**
 * Identity-first 1:N biometric matcher.
 * Routes 512-D AI vectors to pgvector; legacy embeddings use sealed-template scan.
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
      };
    }

    const { modality, embedding, deviceFingerprint } = input.biometric;
    if (!embedding) {
      return {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
      };
    }
    const probe = normalizeEmbedding(embedding);

    const candidates = await prisma.biometricTemplate.findMany({
      where: { modality, status: "active" },
      include: { user: { select: { id: true, trustId: true, status: true } } },
    });

    let best: {
      similarity: number;
      templateId: string;
      userId: string;
      trustId: string;
    } | null = null;

    for (const c of candidates) {
      const stored = openJson<number[]>(c.embeddingSeal);
      const sim = cosineSimilarity(probe, stored);
      if (sim >= LEGACY_MATCH_THRESHOLD && (!best || sim > best.similarity)) {
        best = {
          similarity: sim,
          templateId: c.id,
          userId: c.userId,
          trustId: c.user.trustId,
        };
      }
    }

    if (!best) {
      await recordAudit({
        type: AUDIT_EVENTS.BIOMETRIC_MATCH_FAILED,
        userId: undefined,
        actorType: "system",
        metadata: { modality, reason: "no_match" },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
      };
    }

    await prisma.biometricTemplate.update({
      where: { id: best.templateId },
      data: { lastMatchedAt: new Date() },
    });

    const master = await isMasterTerminal(best.userId, deviceFingerprint);
    const accessLevel =
      master && (!input.requireMasterAccess || master)
        ? TRUST_ID_ACCESS_LEVELS.MASTER
        : TRUST_ID_ACCESS_LEVELS.UNIVERSAL;

    await recordAudit({
      type: AUDIT_EVENTS.BIOMETRIC_MATCHED,
      userId: best.userId,
      actorType: "user",
      actorId: best.userId,
      metadata: {
        modality,
        similarity: best.similarity,
        accessLevel,
        isMasterDevice: master,
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      matched: true,
      userId: best.userId,
      trustId: best.trustId,
      similarity: best.similarity,
      templateId: best.templateId,
      accessLevel,
      isMasterDevice: master,
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
