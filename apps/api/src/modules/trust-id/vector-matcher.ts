import {
  AUDIT_EVENTS,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_PGVECTOR_MAX_DISTANCE,
  TRUST_ID_ACCESS_LEVELS,
  type BiometricModality,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { deviceFingerprintHash } from "../../lib/crypto.js";
import {
  isPgVectorEnabled,
  syncEmbeddingVectorColumn,
  toPgVectorLiteral,
} from "../../lib/pgvector.js";
import { recordAudit } from "../audit/service.js";
import type { BiometricPayload } from "./schemas.js";

export type VectorMatchResult = {
  matched: boolean;
  userId?: string;
  trustId?: string;
  distance?: number;
  similarity?: number;
  embeddingId?: string;
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
};

function normalizeVector(v: number[]): number[] {
  const len = v.length;
  const out = len === BIOMETRIC_AI_EMBEDDING_DIMS ? v : resizeVector(v, BIOMETRIC_AI_EMBEDDING_DIMS);
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return out;
  return out.map((x) => x / norm);
}

function resizeVector(v: number[], dims: number): number[] {
  if (v.length === dims) return [...v];
  const out = new Array<number>(dims).fill(0);
  for (let i = 0; i < dims; i++) {
    out[i] = v[i % v.length] ?? 0;
  }
  return out;
}

function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return 1 - dot;
}

function resolveVector(payload: BiometricPayload): number[] {
  const raw = payload.vector ?? payload.embedding;
  if (!raw) {
    throw Object.assign(new Error("Biometric vector or embedding required"), {
      statusCode: 400,
    });
  }
  return normalizeVector(raw);
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

export class PgVectorMatcherService {
  async enrollEmbedding(input: {
    userId: string;
    trustId: string;
    biometric: BiometricPayload;
    modelName?: string;
    modelVersion?: number;
    ip?: string;
    userAgent?: string;
  }) {
    const { modality } = input.biometric;
    const vector = resolveVector(input.biometric);
    const embeddingJson = JSON.stringify(vector);

    const row = await prisma.biometricEmbedding.upsert({
      where: {
        userId_modality: {
          userId: input.userId,
          modality,
        },
      },
      create: {
        userId: input.userId,
        trustId: input.trustId,
        modality,
        embeddingJson,
        modelName: input.modelName ?? BIOMETRIC_AI_MODEL_NAME,
        modelVersion: input.modelVersion ?? 1,
        status: "active",
      },
      update: {
        trustId: input.trustId,
        embeddingJson,
        modelName: input.modelName ?? BIOMETRIC_AI_MODEL_NAME,
        modelVersion: input.modelVersion ?? 1,
        status: "active",
      },
    });

    await syncEmbeddingVectorColumn(row.id, vector);

    await recordAudit({
      type: AUDIT_EVENTS.BIOMETRIC_ENROLLED,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: { modality, embeddingId: row.id, engine: "pgvector-ai" },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { embeddingId: row.id, modality };
  }

  /**
   * 1:N AI vector search  pgvector cosine distance on PostgreSQL,
   * in-memory fallback on SQLite for tests.
   */
  async matchOneToMany(input: {
    biometric: BiometricPayload;
    requireMasterAccess?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<VectorMatchResult> {
    const { modality, deviceFingerprint } = input.biometric;
    const probe = resolveVector(input.biometric);

    const pgMatch = await this.matchPgVector(probe, modality);
    const best = pgMatch ?? (await this.matchInMemory(probe, modality));

    if (!best || best.distance >= BIOMETRIC_PGVECTOR_MAX_DISTANCE) {
      await recordAudit({
        type: AUDIT_EVENTS.BIOMETRIC_MATCH_FAILED,
        actorType: "system",
        metadata: {
          modality,
          reason: "no_ai_vector_match",
          distance: best?.distance,
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
      };
    }

    await prisma.biometricEmbedding.update({
      where: { id: best.embeddingId },
      data: { lastMatchedAt: new Date() },
    });

    const master = await isMasterTerminal(best.userId, deviceFingerprint);
    const accessLevel =
      master && (!input.requireMasterAccess || master)
        ? TRUST_ID_ACCESS_LEVELS.MASTER
        : TRUST_ID_ACCESS_LEVELS.UNIVERSAL;

    const similarity = 1 - best.distance;

    await recordAudit({
      type: AUDIT_EVENTS.BIOMETRIC_MATCHED,
      userId: best.userId,
      actorType: "user",
      actorId: best.userId,
      metadata: {
        modality,
        distance: best.distance,
        similarity,
        accessLevel,
        isMasterDevice: master,
        engine: "pgvector-ai",
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      matched: true,
      userId: best.userId,
      trustId: best.trustId,
      distance: best.distance,
      similarity,
      embeddingId: best.embeddingId,
      accessLevel,
      isMasterDevice: master,
    };
  }

  private async matchPgVector(
    probe: number[],
    modality: BiometricModality,
  ): Promise<{
    embeddingId: string;
    userId: string;
    trustId: string;
    distance: number;
  } | null> {
    if (!(await isPgVectorEnabled())) return null;

    const literal = toPgVectorLiteral(probe);
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; user_id: string; trust_id: string; distance: number }>
    >(
      `
      SELECT id, user_id, trust_id, (vector <=> '${literal}'::vector) AS distance
      FROM biometric_embeddings
      WHERE modality = '${modality}' AND status = 'active' AND vector IS NOT NULL
      ORDER BY vector <=> '${literal}'::vector
      LIMIT 1
      `,
    );

    const hit = rows[0];
    if (!hit) return null;

    return {
      embeddingId: hit.id,
      userId: hit.user_id,
      trustId: hit.trust_id,
      distance: Number(hit.distance),
    };
  }

  private async matchInMemory(
    probe: number[],
    modality: BiometricModality,
  ): Promise<{
    embeddingId: string;
    userId: string;
    trustId: string;
    distance: number;
  } | null> {
    const candidates = await prisma.biometricEmbedding.findMany({
      where: { modality, status: "active" },
      select: {
        id: true,
        userId: true,
        trustId: true,
        embeddingJson: true,
      },
    });

    let best: {
      embeddingId: string;
      userId: string;
      trustId: string;
      distance: number;
    } | null = null;

    for (const c of candidates) {
      const stored = JSON.parse(c.embeddingJson) as number[];
      const distance = cosineDistance(probe, normalizeVector(stored));
      if (!best || distance < best.distance) {
        best = {
          embeddingId: c.id,
          userId: c.userId,
          trustId: c.trustId,
          distance,
        };
      }
    }

    return best;
  }
}

export const pgVectorMatcher = new PgVectorMatcherService();

export function isAiVectorPayload(payload: BiometricPayload): boolean {
  if (payload.vector?.length === BIOMETRIC_AI_EMBEDDING_DIMS) return true;
  return (payload.embedding?.length ?? 0) >= 128;
}
