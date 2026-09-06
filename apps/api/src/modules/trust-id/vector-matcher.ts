import {
  AUDIT_EVENTS,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_LEGACY_MODEL_NAMES,
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
import {
  cacheUserVector,
  searchHotVectorCache,
} from "./vector-hot-cache.js";

export type VectorMatchResult = {
  matched: boolean;
  userId?: string;
  trustId?: string;
  distance?: number;
  similarity?: number;
  embeddingId?: string;
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
  cacheHit?: boolean;
  durationMs?: number;
  error?: string;
  errorCode?: string;
};

function isLegacyModelName(name: string | undefined | null): boolean {
  if (!name) return false;
  return (BIOMETRIC_LEGACY_MODEL_NAMES as readonly string[]).includes(name);
}

function isLegacyStoredTemplate(
  modelName: string | undefined | null,
  embeddingJson: string,
): boolean {
  if (isLegacyModelName(modelName)) return true;
  const parsed = parseStoredVector(embeddingJson);
  // Raw JSON arrays are pre-ArcFace spatial/legacy enrollments
  return parsed.legacy === true;
}

function parseStoredVector(embeddingJson: string): {
  vector: number[];
  modelName?: string;
  gallery?: number[][];
  legacy: boolean;
} {
  try {
    const parsed = JSON.parse(embeddingJson) as unknown;
    if (Array.isArray(parsed)) {
      return { vector: parsed as number[], legacy: true };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as {
        schema?: string;
        primary?: number[];
        gallery?: number[][];
        modelName?: string;
      };
      if (obj.primary && Array.isArray(obj.primary)) {
        return {
          vector: obj.primary,
          gallery: obj.gallery,
          modelName: obj.modelName,
          legacy: isLegacyModelName(obj.modelName),
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { vector: [], legacy: true };
}

function normalizeVector(v: number[]): number[] {
  const len = v.length;
  if (len !== BIOMETRIC_AI_EMBEDDING_DIMS) {
    throw Object.assign(
      new Error(
        `Invalid embedding length ${len}; expected ${BIOMETRIC_AI_EMBEDDING_DIMS}`,
      ),
      { statusCode: 400, errorCode: BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED },
    );
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
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

function maxDistance(): number {
  const raw = process.env.FAST_VECTOR_MAX_DISTANCE;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return BIOMETRIC_PGVECTOR_MAX_DISTANCE;
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
    const modelName =
      input.modelName ??
      input.biometric.modelName ??
      BIOMETRIC_AI_MODEL_NAME;
    if (isLegacyModelName(modelName)) {
      throw Object.assign(
        new Error(
          "Legacy spatial/non-ArcFace templates cannot be enrolled. Use the production face pipeline.",
        ),
        {
          statusCode: 400,
          errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        },
      );
    }

    const vector = resolveVector(input.biometric);
    const envelope = {
      schema: "trustid_face_template_v1",
      primary: vector,
      gallery: [vector],
      modelName,
      modelVersion:
        input.modelVersion ??
        input.biometric.modelVersion ??
        BIOMETRIC_AI_MODEL_VERSION,
    };
    const embeddingJson = JSON.stringify(envelope);

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
        modelName,
        modelVersion: envelope.modelVersion,
        status: "active",
      },
      update: {
        trustId: input.trustId,
        embeddingJson,
        modelName,
        modelVersion: envelope.modelVersion,
        status: "active",
      },
    });

    await syncEmbeddingVectorColumn(row.id, vector);
    void cacheUserVector({
      userId: input.userId,
      trustId: input.trustId,
      embeddingId: row.id,
      vector,
    });

    await recordAudit({
      type: AUDIT_EVENTS.BIOMETRIC_ENROLLED,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: {
        modality,
        embeddingId: row.id,
        engine: "pgvector-arcface",
        modelName,
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { embeddingId: row.id, modality };
  }

  /**
   * Two-pass cascade: hot cache ? HNSW pgvector ? in-memory scan.
   */
  async matchOneToMany(input: {
    biometric: BiometricPayload;
    requireMasterAccess?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<VectorMatchResult> {
    const started = performance.now();
    const { modality, deviceFingerprint } = input.biometric;

    if (isLegacyModelName(input.biometric.modelName)) {
      return {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        error:
          "Probe embedding uses a legacy/non-ArcFace model. Re-capture with the production face pipeline.",
        durationMs: performance.now() - started,
      };
    }

    const probe = resolveVector(input.biometric);
    const threshold = maxDistance();

    const hot = await searchHotVectorCache(probe, threshold);
    const best = hot
      ? {
          embeddingId: hot.embeddingId,
          userId: hot.userId,
          trustId: hot.trustId,
          distance: hot.distance,
          cacheHit: true as const,
        }
      : ((await this.matchPgVector(probe, modality, threshold)) ??
        (await this.matchInMemory(probe, modality)));

    const durationMs = performance.now() - started;

    if (!best || best.distance >= threshold) {
      await recordAudit({
        type: AUDIT_EVENTS.BIOMETRIC_MATCH_FAILED,
        actorType: "system",
        metadata: {
          modality,
          reason: "no_ai_vector_match",
          distance: best?.distance,
          durationMs,
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs,
        cacheHit: false,
        errorCode: BIOMETRIC_ERROR_CODES.NO_MATCH,
      };
    }

    // Reject matches against legacy gallery templates
    const stored = await prisma.biometricEmbedding.findUnique({
      where: { id: best.embeddingId },
      select: { modelName: true, embeddingJson: true },
    });
    if (
      !stored ||
      isLegacyStoredTemplate(stored.modelName, stored.embeddingJson)
    ) {
      return {
        matched: false,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        error:
          "Matched template is legacy/incompatible. Re-enroll face biometrics.",
      };
    }

    await prisma.biometricEmbedding.update({
      where: { id: best.embeddingId },
      data: { lastMatchedAt: new Date() },
    }).catch(() => undefined);

    const enrolled = parseStoredVector(stored.embeddingJson).vector;
    void cacheUserVector({
      userId: best.userId,
      trustId: best.trustId,
      embeddingId: best.embeddingId,
      vector: enrolled.length ? enrolled : probe,
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
        engine: "pgvector-arcface",
        cacheHit: "cacheHit" in best && best.cacheHit,
        durationMs,
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
      cacheHit: "cacheHit" in best && best.cacheHit,
      durationMs,
    };
  }

  private async matchPgVector(
    probe: number[],
    modality: BiometricModality,
    threshold: number,
  ): Promise<{
    embeddingId: string;
    userId: string;
    trustId: string;
    distance: number;
  } | null> {
    if (!(await isPgVectorEnabled())) return null;

    const literal = toPgVectorLiteral(probe);
    try {
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          user_id: string;
          trust_id: string;
          distance: number;
        }>
      >(
        `
        SELECT * FROM search_biometric_vector(
          '${literal}'::vector,
          '${modality}',
          ${threshold}
        )
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
    } catch {
      await prisma
        .$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 40`)
        .catch(() => undefined);
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          user_id: string;
          trust_id: string;
          distance: number;
        }>
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
      const parsed = parseStoredVector(c.embeddingJson);
      if (parsed.legacy || !parsed.vector.length) continue;
      const distance = cosineDistance(probe, normalizeVector(parsed.vector));
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
