/**
 * Face template enroll + match.
 *
 * 1:1 VERIFY — bounded fetch of claimed identity template only.
 * 1:N IDENTIFY — pgvector Top-K → exact cosine rerank → threshold.
 *
 * NEVER loads the full biometric gallery into Node memory.
 */
import {
  AUDIT_EVENTS,
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_ANN_QUERY_TIMEOUT_MS,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_ERROR_CODES,
  BIOMETRIC_HNSW_EF_SEARCH_DEFAULT,
  BIOMETRIC_MATCH_MODE,
  BIOMETRIC_PIPELINE_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
  BIOMETRIC_THRESHOLD_POLICY,
  isLegacyBiometricModelName,
  isProductionArcFaceModelName,
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
  decideAfterRerank,
  exactRerankCandidates,
  type AnnCandidate,
} from "./ann-rerank.js";
import {
  acceptsAtThreshold,
  resolveTopK,
} from "./match-semantics.js";
import {
  cacheUserVector,
  searchHotVectorCache,
} from "./vector-hot-cache.js";

export type VectorMatchResult = {
  matched: boolean;
  mode?: typeof BIOMETRIC_MATCH_MODE.VERIFY_1_1 | typeof BIOMETRIC_MATCH_MODE.IDENTIFY_1_N;
  userId?: string;
  trustId?: string;
  distance?: number;
  similarity?: number;
  embeddingId?: string;
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
  cacheHit?: boolean;
  durationMs?: number;
  candidateCount?: number;
  topK?: number;
  thresholdStatus?: typeof BIOMETRIC_THRESHOLD_POLICY.status;
  error?: string;
  errorCode?: string;
};

function isLegacyModelName(name: string | undefined | null): boolean {
  return isLegacyBiometricModelName(name);
}

function isLegacyStoredTemplate(
  modelName: string | undefined | null,
  embeddingJson: string,
): boolean {
  if (isLegacyModelName(modelName)) return true;
  const parsed = parseStoredVector(embeddingJson);
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

function operatingThresholdDistance(): number {
  const raw = process.env.FAST_VECTOR_MAX_DISTANCE;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return BIOMETRIC_THRESHOLD_POLICY.threshold;
}

function requireCalibratedThreshold(): boolean {
  return process.env.BIOMETRIC_REQUIRE_CALIBRATED_THRESHOLD === "true";
}

function annTimeoutMs(): number {
  const raw = process.env.BIOMETRIC_ANN_QUERY_TIMEOUT_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return BIOMETRIC_ANN_QUERY_TIMEOUT_MS;
}

function resolveAnnTopK(): number {
  const raw = process.env.BIOMETRIC_ANN_TOP_K;
  if (raw != null && raw !== "") {
    return resolveTopK(Number(raw));
  }
  return resolveTopK();
}

function resolveEfSearch(topK: number): number {
  const raw = process.env.BIOMETRIC_HNSW_EF_SEARCH;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.max(n, topK);
  }
  return Math.max(BIOMETRIC_HNSW_EF_SEARCH_DEFAULT, topK);
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

function logMatchEvent(
  level: "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown>,
) {
  // Never log embeddings / vectors
  const safe = { ...meta };
  delete safe.probe;
  delete safe.vector;
  delete safe.embedding;
  delete safe.embeddingJson;
  const line = JSON.stringify({ scope: "biometric_match", event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export class PgVectorMatcherService {
  async enrollEmbedding(input: {
    userId: string;
    trustId: string;
    biometric: BiometricPayload;
    modelName?: string;
    modelVersion?: number;
    galleryVectors?: number[][];
    ip?: string;
    userAgent?: string;
  }) {
    const { modality } = input.biometric;
    const modelName =
      input.modelName ??
      input.biometric.modelName ??
      "";
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
    // Face enroll must explicitly declare the production ArcFace model.
    // Do not default-missing modelName to ArcFace — that hid legacy callers.
    if (modality === "face" && !isProductionArcFaceModelName(modelName)) {
      throw Object.assign(
        new Error(
          "Face enrollment requires the production ArcFace pipeline " +
            `(modelName=${BIOMETRIC_AI_MODEL_NAME}). Received: ${modelName || "missing"}.`,
        ),
        {
          statusCode: 400,
          errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        },
      );
    }
    const resolvedModelName =
      modality === "face"
        ? BIOMETRIC_AI_MODEL_NAME
        : modelName || "fingerprint_keystore_v1";

    const vector = resolveVector(input.biometric);
    const gallery =
      input.galleryVectors?.length &&
      input.galleryVectors.every((g) => g.length === BIOMETRIC_AI_EMBEDDING_DIMS)
        ? input.galleryVectors.map((g) => normalizeVector(g))
        : [vector];

    const envelope = {
      schema: "trustid_face_template_v1",
      primary: vector,
      gallery,
      modelName: resolvedModelName,
      modelVersion:
        input.modelVersion ??
        input.biometric.modelVersion ??
        BIOMETRIC_AI_MODEL_VERSION,
      detectorVersion: BIOMETRIC_DETECTOR_VERSION,
      alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
      preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
      pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
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
        modelName: resolvedModelName,
        modelVersion: envelope.modelVersion,
        status: "active",
      },
      update: {
        trustId: input.trustId,
        embeddingJson,
        modelName: resolvedModelName,
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
        modelName: resolvedModelName,
        gallerySize: gallery.length,
        pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
        // no vectors
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { embeddingId: row.id, modality };
  }

  /**
   * 1:1 verification against a claimed Trust ID — never scans the gallery.
   */
  async verifyOneToOne(input: {
    claimedTrustId: string;
    biometric: BiometricPayload;
    requireMasterAccess?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<VectorMatchResult> {
    const started = performance.now();
    const mode = BIOMETRIC_MATCH_MODE.VERIFY_1_1;
    const threshold = operatingThresholdDistance();

    if (requireCalibratedThreshold() && BIOMETRIC_THRESHOLD_POLICY.status !== "CALIBRATED") {
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs: performance.now() - started,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_THRESHOLD_UNCALIBRATED,
        error: "Biometric threshold is UNCALIBRATED; acceptance gated.",
      };
    }

    if (isLegacyModelName(input.biometric.modelName)) {
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        durationMs: performance.now() - started,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
      };
    }

    const probe = resolveVector(input.biometric);
    const trustId = input.claimedTrustId.trim();
    if (!trustId) {
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        errorCode: BIOMETRIC_ERROR_CODES.NO_MATCH,
        durationMs: performance.now() - started,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
      };
    }

    const row = await prisma.biometricEmbedding.findFirst({
      where: {
        trustId,
        modality: input.biometric.modality,
        status: "active",
      },
      select: {
        id: true,
        userId: true,
        trustId: true,
        modelName: true,
        embeddingJson: true,
      },
    });

    if (!row || isLegacyStoredTemplate(row.modelName, row.embeddingJson)) {
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        errorCode: row
          ? BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY
          : BIOMETRIC_ERROR_CODES.NO_MATCH,
        durationMs: performance.now() - started,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
      };
    }

    const enrolled = parseStoredVector(row.embeddingJson);
    const templates =
      enrolled.gallery?.length && enrolled.gallery.length > 0
        ? enrolled.gallery
        : [enrolled.vector];
    let bestDistance = Infinity;
    for (const t of templates) {
      if (t.length !== BIOMETRIC_AI_EMBEDDING_DIMS) continue;
      const d = cosineDistance(probe, normalizeVector(t));
      if (d < bestDistance) bestDistance = d;
    }

    const durationMs = performance.now() - started;
    if (!Number.isFinite(bestDistance) || !acceptsAtThreshold(bestDistance, threshold)) {
      logMatchEvent("info", "verify_1_1_no_match", {
        mode,
        durationMs,
        threshold,
        // distance only, no vector
        distance: Number.isFinite(bestDistance) ? bestDistance : undefined,
      });
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        distance: Number.isFinite(bestDistance) ? bestDistance : undefined,
        durationMs,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        errorCode: BIOMETRIC_ERROR_CODES.NO_MATCH,
      };
    }

    const master = await isMasterTerminal(
      row.userId,
      input.biometric.deviceFingerprint,
    );
    void cacheUserVector({
      userId: row.userId,
      trustId: row.trustId,
      embeddingId: row.id,
      vector: enrolled.vector,
    });

    return {
      matched: true,
      mode,
      userId: row.userId,
      trustId: row.trustId,
      embeddingId: row.id,
      distance: bestDistance,
      similarity: 1 - bestDistance,
      accessLevel: master
        ? TRUST_ID_ACCESS_LEVELS.MASTER
        : TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
      isMasterDevice: master,
      durationMs,
      thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
    };
  }

  /**
   * 1:N identification: hot cache (bounded) → ANN Top-K → exact rerank → threshold.
   * Fail closed if ANN backend unavailable — never full-gallery Node scan.
   */
  async identifyOneToMany(input: {
    biometric: BiometricPayload;
    requireMasterAccess?: boolean;
    topK?: number;
    ip?: string;
    userAgent?: string;
  }): Promise<VectorMatchResult> {
    const started = performance.now();
    const mode = BIOMETRIC_MATCH_MODE.IDENTIFY_1_N;
    const { modality, deviceFingerprint } = input.biometric;
    const threshold = operatingThresholdDistance();
    const topK = resolveTopK(input.topK ?? resolveAnnTopK());

    if (requireCalibratedThreshold() && BIOMETRIC_THRESHOLD_POLICY.status !== "CALIBRATED") {
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs: performance.now() - started,
        topK,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_THRESHOLD_UNCALIBRATED,
        error: "Biometric threshold is UNCALIBRATED; acceptance gated.",
      };
    }

    if (isLegacyModelName(input.biometric.modelName)) {
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        error:
          "Probe embedding uses a legacy/non-ArcFace model. Re-capture with the production face pipeline.",
        durationMs: performance.now() - started,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
      };
    }

    const probe = resolveVector(input.biometric);

    // Bounded hot cache only (cap 256) — not a full-gallery scan
    const hot = await searchHotVectorCache(probe, threshold);
    if (hot && acceptsAtThreshold(hot.distance, threshold)) {
      return this.finalizeIdentifyHit({
        best: {
          embeddingId: hot.embeddingId,
          userId: hot.userId,
          trustId: hot.trustId,
          distance: hot.distance,
        },
        probe,
        modality,
        deviceFingerprint,
        requireMasterAccess: input.requireMasterAccess,
        started,
        cacheHit: true,
        topK,
        candidateCount: 1,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    }

    const ann = await this.fetchAnnTopK(probe, modality, topK);
    if (ann.status === "unavailable") {
      logMatchEvent("error", "ann_unavailable_fail_closed", {
        mode,
        reason: ann.reason,
        durationMs: performance.now() - started,
        topK,
      });
      await recordAudit({
        type: AUDIT_EVENTS.BIOMETRIC_MATCH_FAILED,
        actorType: "system",
        metadata: {
          modality,
          reason: "biometric_service_unavailable",
          annReason: ann.reason,
          durationMs: performance.now() - started,
          topK,
          // no vectors
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs: performance.now() - started,
        topK,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_SERVICE_UNAVAILABLE,
        error:
          "Biometric identification service unavailable. Full-gallery fallback is disabled.",
      };
    }

    const ranked = exactRerankCandidates(probe, ann.candidates);
    const decision = decideAfterRerank(ranked, threshold);

    if (!decision.accepted) {
      await recordAudit({
        type: AUDIT_EVENTS.BIOMETRIC_MATCH_FAILED,
        actorType: "system",
        metadata: {
          modality,
          reason: "no_ai_vector_match",
          candidateCount: ranked.length,
          topK,
          bestDistance: ranked[0]?.distance,
          durationMs: performance.now() - started,
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        matched: false,
        mode,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs: performance.now() - started,
        cacheHit: false,
        candidateCount: ranked.length,
        topK,
        distance: ranked[0]?.distance,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        errorCode: BIOMETRIC_ERROR_CODES.NO_MATCH,
      };
    }

    return this.finalizeIdentifyHit({
      best: decision.accepted,
      probe,
      modality,
      deviceFingerprint,
      requireMasterAccess: input.requireMasterAccess,
      started,
      cacheHit: false,
      topK,
      candidateCount: ranked.length,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  /** @deprecated Use identifyOneToMany — name kept for callers */
  async matchOneToMany(input: {
    biometric: BiometricPayload;
    requireMasterAccess?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<VectorMatchResult> {
    return this.identifyOneToMany(input);
  }

  private async finalizeIdentifyHit(input: {
    best: {
      embeddingId: string;
      userId: string;
      trustId: string;
      distance: number;
    };
    probe: number[];
    modality: BiometricModality;
    deviceFingerprint?: string;
    requireMasterAccess?: boolean;
    started: number;
    cacheHit: boolean;
    topK: number;
    candidateCount: number;
    ip?: string;
    userAgent?: string;
  }): Promise<VectorMatchResult> {
    const durationMs = performance.now() - input.started;
    const stored = await prisma.biometricEmbedding.findUnique({
      where: { id: input.best.embeddingId },
      select: { modelName: true, embeddingJson: true },
    });
    if (
      !stored ||
      isLegacyStoredTemplate(stored.modelName, stored.embeddingJson)
    ) {
      return {
        matched: false,
        mode: BIOMETRIC_MATCH_MODE.IDENTIFY_1_N,
        accessLevel: TRUST_ID_ACCESS_LEVELS.UNIVERSAL,
        isMasterDevice: false,
        durationMs,
        topK: input.topK,
        candidateCount: input.candidateCount,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        errorCode: BIOMETRIC_ERROR_CODES.BIOMETRIC_TEMPLATE_LEGACY,
        error:
          "Matched template is legacy/incompatible. Re-enroll face biometrics.",
      };
    }

    await prisma.biometricEmbedding
      .update({
        where: { id: input.best.embeddingId },
        data: { lastMatchedAt: new Date() },
      })
      .catch(() => undefined);

    const enrolled = parseStoredVector(stored.embeddingJson).vector;
    void cacheUserVector({
      userId: input.best.userId,
      trustId: input.best.trustId,
      embeddingId: input.best.embeddingId,
      vector: enrolled.length ? enrolled : input.probe,
    });

    const master = await isMasterTerminal(
      input.best.userId,
      input.deviceFingerprint,
    );
    const accessLevel =
      master && (!input.requireMasterAccess || master)
        ? TRUST_ID_ACCESS_LEVELS.MASTER
        : TRUST_ID_ACCESS_LEVELS.UNIVERSAL;
    const similarity = 1 - input.best.distance;

    await recordAudit({
      type: AUDIT_EVENTS.BIOMETRIC_MATCHED,
      userId: input.best.userId,
      actorType: "user",
      actorId: input.best.userId,
      metadata: {
        modality: input.modality,
        mode: BIOMETRIC_MATCH_MODE.IDENTIFY_1_N,
        distance: input.best.distance,
        similarity,
        accessLevel,
        isMasterDevice: master,
        engine: "pgvector-arcface-topk-rerank",
        cacheHit: input.cacheHit,
        topK: input.topK,
        candidateCount: input.candidateCount,
        thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
        durationMs,
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      matched: true,
      mode: BIOMETRIC_MATCH_MODE.IDENTIFY_1_N,
      userId: input.best.userId,
      trustId: input.best.trustId,
      distance: input.best.distance,
      similarity,
      embeddingId: input.best.embeddingId,
      accessLevel,
      isMasterDevice: master,
      cacheHit: input.cacheHit,
      durationMs,
      topK: input.topK,
      candidateCount: input.candidateCount,
      thresholdStatus: BIOMETRIC_THRESHOLD_POLICY.status,
    };
  }

  /**
   * Bounded Top-K ANN candidate generation via pgvector.
   * On failure: unavailable — callers must fail closed (no full-gallery scan).
   */
  private async fetchAnnTopK(
    probe: number[],
    modality: BiometricModality,
    topK: number,
  ): Promise<
    | { status: "ok"; candidates: AnnCandidate[] }
    | { status: "unavailable"; reason: string }
  > {
    if (!(await isPgVectorEnabled())) {
      // Empty gallery → NO_MATCH (no ANN needed). Non-empty without ANN → fail closed.
      const activeCount = await prisma.biometricEmbedding.count({
        where: { modality, status: "active" },
      });
      if (activeCount === 0) {
        return { status: "ok", candidates: [] };
      }
      return { status: "unavailable", reason: "pgvector_disabled" };
    }

    const literal = toPgVectorLiteral(probe);
    const ef = resolveEfSearch(topK);
    const timeoutMs = annTimeoutMs();

    try {
      await prisma.$executeRawUnsafe(
        `SET LOCAL statement_timeout = '${timeoutMs}'`,
      );
      await prisma.$executeRawUnsafe(
        `SELECT set_config('hnsw.ef_search', '${ef}', true)`,
      );

      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          user_id: string;
          trust_id: string;
          distance: number;
          embedding_json: string | null;
        }>
      >(
        `
        SELECT
          be.id::text AS id,
          be.user_id::text AS user_id,
          be.trust_id::text AS trust_id,
          (be.vector <=> '${literal}'::vector)::float AS distance,
          be.embedding_json::text AS embedding_json
        FROM biometric_embeddings be
        WHERE be.modality = '${modality}'
          AND be.status = 'active'
          AND be.vector IS NOT NULL
        ORDER BY be.vector <=> '${literal}'::vector ASC
        LIMIT ${Math.floor(topK)}
        `,
      );

      const candidates: AnnCandidate[] = [];
      for (const row of rows) {
        const parsed = row.embedding_json
          ? parseStoredVector(row.embedding_json)
          : { vector: [] as number[], legacy: true };
        candidates.push({
          embeddingId: row.id,
          userId: row.user_id,
          trustId: row.trust_id,
          annDistance: Number(row.distance),
          vector:
            !parsed.legacy && parsed.vector.length === BIOMETRIC_AI_EMBEDDING_DIMS
              ? normalizeVector(parsed.vector)
              : undefined,
        });
      }
      return { status: "ok", candidates };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ann_query_failed";
      logMatchEvent("error", "ann_query_failed", {
        reason: msg.slice(0, 200),
        topK,
      });
      return { status: "unavailable", reason: "ann_query_failed" };
    }
  }
}

export const pgVectorMatcher = new PgVectorMatcherService();

/** Test helper: ensure matchInMemory symbol does not exist on the service */
export function __assertNoFullGalleryFallback(): boolean {
  const proto = PgVectorMatcherService.prototype as unknown as Record<
    string,
    unknown
  >;
  return typeof proto.matchInMemory !== "function";
}

export function isAiVectorPayload(payload: BiometricPayload): boolean {
  if (payload.vector?.length === BIOMETRIC_AI_EMBEDDING_DIMS) return true;
  return (payload.embedding?.length ?? 0) >= 128;
}
