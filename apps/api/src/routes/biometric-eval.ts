/**
 * INTERNAL biometric evaluation collector API.
 * Gate: EVAL_BIOMETRIC_SECRET via header x-eval-biometric-secret.
 * Absent secret ? routes return 404 (not publicly enumerable).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
} from "@trustid/shared";
import {
  adminSummary,
  createParticipant,
  deleteParticipant,
  EVAL_DATASET_VERSION,
  EVAL_MIN_ACCEPTED_PER_SESSION,
  EVAL_SESSION_PROTOCOL,
  getEvalDataRoot,
  listAllCaptures,
  listParticipantProgress,
  startSession,
  storeCapture,
  type EvalSessionKey,
} from "../modules/biometric-eval/store.js";
import { buildLabeledExportFromCaptures } from "../modules/biometric-eval/export-labeled.js";
import { validateLabeledDatasetJson } from "../modules/biometric-eval/validate-labeled.js";

function evalSecret(): string | undefined {
  return process.env.EVAL_BIOMETRIC_SECRET?.trim() || undefined;
}

function requireEvalSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = evalSecret();
  if (!secret) {
    void reply.code(404).send({ error: "not_found" });
    return false;
  }
  const header = req.headers["x-eval-biometric-secret"];
  if (header !== secret) {
    void reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

function logSafe(event: string, meta: Record<string, unknown>) {
  const safe = { ...meta };
  delete safe.embedding;
  delete safe.imageBase64;
  delete safe.vector;
  console.info(JSON.stringify({ scope: "biometric_eval", event, ...safe }));
}

const consentSchema = z.object({
  consent_given: z.literal(true),
  consent_timestamp: z.string().min(8).optional(),
  dataset_version: z.string().optional(),
});

const sessionSchema = z.object({
  subject_id: z.string().min(8).max(80),
  sessionKey: z.enum([
    "enrollment_neutral",
    "lighting_and_expression",
    "pose_and_distance",
  ]),
});

const captureSchema = z.object({
  subject_id: z.string().min(8).max(80),
  sessionId: z.string().min(8).max(80),
  embedding: z.array(z.number()).length(BIOMETRIC_AI_EMBEDDING_DIMS),
  qualityScore: z.number().min(0).max(1).optional(),
  active_liveness_check: z.enum(["passed", "skipped", "failed"]).optional(),
  conditionTags: z.array(z.string().max(64)).max(16).optional(),
  imageBase64: z.string().max(4_000_000).optional(),
  imageMime: z.enum(["image/png", "image/jpeg"]).optional(),
});

export async function biometricEvalRoutes(app: FastifyInstance) {
  app.get("/internal/biometric-eval/status", async (req, reply) => {
    if (!requireEvalSecret(req, reply)) return;
    return {
      ok: true,
      purpose: "INTERNAL_BIOMETRIC_EVALUATION_NOT_PRODUCTION_ENROLLMENT",
      padStatus: "INCOMPLETE",
      activeLiveness: "blink_optional_recorded_as_active_liveness_check",
      minAcceptedPerSession: EVAL_MIN_ACCEPTED_PER_SESSION,
      protocol: EVAL_SESSION_PROTOCOL,
      dataRootConfigured: Boolean(process.env.TRUSTID_EVAL_DATA_ROOT),
    };
  });

  app.get("/internal/biometric-eval/admin", async (req, reply) => {
    if (!requireEvalSecret(req, reply)) return;
    const summary = adminSummary();
    // Never include embeddings in admin listing
    return summary;
  });

  app.post("/internal/biometric-eval/participants", async (req, reply) => {
    if (!requireEvalSecret(req, reply)) return;
    const body = consentSchema.parse(req.body ?? {});
    try {
      const meta = createParticipant({
        consent_given: true,
        consent_timestamp:
          body.consent_timestamp ?? new Date().toISOString(),
        dataset_version: body.dataset_version ?? EVAL_DATASET_VERSION,
      });
      logSafe("participant_created", { subject_id: meta.subject_id });
      return { participant: meta };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : "failed",
      });
    }
  });

  app.get(
    "/internal/biometric-eval/participants/:subjectId",
    async (req, reply) => {
      if (!requireEvalSecret(req, reply)) return;
      const { subjectId } = req.params as { subjectId: string };
      const prog = listParticipantProgress(subjectId);
      if (!prog) return reply.code(404).send({ error: "not_found" });
      return prog;
    },
  );

  app.post("/internal/biometric-eval/sessions", async (req, reply) => {
    if (!requireEvalSecret(req, reply)) return;
    const body = sessionSchema.parse(req.body ?? {});
    try {
      const session = startSession({
        subjectId: body.subject_id,
        sessionKey: body.sessionKey as EvalSessionKey,
      });
      logSafe("session_started", {
        subject_id: body.subject_id,
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
      });
      return { session };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : "failed",
        errorCode: (err as { errorCode?: string }).errorCode,
      });
    }
  });

  app.post("/internal/biometric-eval/captures", async (req, reply) => {
    if (!requireEvalSecret(req, reply)) return;
    const body = captureSchema.parse(req.body ?? {});
    try {
      const record = storeCapture({
        subjectId: body.subject_id,
        sessionId: body.sessionId,
        embedding: body.embedding,
        qualityScore: body.qualityScore,
        active_liveness_check: body.active_liveness_check,
        conditionTags: body.conditionTags,
        imageBase64: body.imageBase64,
        imageMime: body.imageMime,
      });
      logSafe("capture_stored", {
        subject_id: record.subject_id,
        sessionId: record.sessionId,
        captureId: record.captureId,
        hasImage: Boolean(record.imagePath),
      });
      // Do not echo embedding back unless needed  return ids only
      return {
        ok: true,
        captureId: record.captureId,
        sampleId: record.sampleId,
        imagePath: record.imagePath,
        qualityScore: record.qualityScore,
      };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : "failed",
        errorCode: (err as { errorCode?: string }).errorCode,
      });
    }
  });

  app.post("/internal/biometric-eval/export", async (req, reply) => {
    if (!requireEvalSecret(req, reply)) return;
    const captures = listAllCaptures();
    const labeled = buildLabeledExportFromCaptures(captures);
    const validation = validateLabeledDatasetJson(labeled, {
      requireImagePath: false,
    });
    const outPath = join(getEvalDataRoot(), "exports", "labeled.json");
    writeFileSync(outPath, JSON.stringify(labeled, null, 2));
    logSafe("dataset_exported", {
      path: "exports/labeled.json",
      subjects: validation.stats.subjects,
      samples: validation.stats.samples,
      DATASET_VALID: validation.DATASET_VALID,
    });
    return {
      ok: true,
      path: outPath,
      relativePath: "exports/labeled.json",
      validation,
      BIOMETRIC_EVIDENCE_STATUS:
        validation.stats.subjects > 0
          ? "DATASET_EXPORTED_NOT_YET_BENCHMARKED"
          : "BLOCKED_BY_DATASET",
    };
  });

  app.delete(
    "/internal/biometric-eval/participants/:subjectId",
    async (req, reply) => {
      if (!requireEvalSecret(req, reply)) return;
      const { subjectId } = req.params as { subjectId: string };
      try {
        deleteParticipant(subjectId);
        logSafe("participant_deleted", { subject_id: subjectId });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        return reply.code(status).send({
          error: err instanceof Error ? err.message : "failed",
        });
      }
    },
  );
}
