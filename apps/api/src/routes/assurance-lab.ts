/**
 * TrustID Assurance Lab API (development/testing only).
 *
 * Every route returns 404 unless TRUSTID_ASSURANCE_LAB_ENABLED=true, a
 * TRUSTID_ASSURANCE_LAB_SECRET is configured, and NODE_ENV is not production.
 * Lab responses are EVALUATION_RESULTs: no sessions, cookies, TrustIDs,
 * authority, or writes to production biometric data. Raw media is refused.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LabCaptureCondition, LabSession } from "@trustid/sdk/assurance-lab";
import { newLabId, isLabId } from "../modules/assurance-lab/store.js";
import {
  buildLabReport,
  loadLabSdk,
  openStudy,
  productionConfigurationSnapshot,
  sha256Hex,
  type LabSdk,
} from "../modules/assurance-lab/service.js";

export const ASSURANCE_LAB_PREFIX = "/internal/assurance-lab";
const MIN_SECRET_LENGTH = 16;

export function assuranceLabGate():
  | { enabled: true; secret: string }
  | { enabled: false; reason: "DISABLED" | "SECRET_MISSING" | "PRODUCTION_ENVIRONMENT" } {
  if (process.env.TRUSTID_ASSURANCE_LAB_ENABLED !== "true") return { enabled: false, reason: "DISABLED" };
  if (process.env.NODE_ENV === "production") return { enabled: false, reason: "PRODUCTION_ENVIRONMENT" };
  const secret = process.env.TRUSTID_ASSURANCE_LAB_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return { enabled: false, reason: "SECRET_MISSING" };
  return { enabled: true, secret };
}

function secretMatches(provided: unknown, secret: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const RAW_MEDIA_KEY = /(image|frame|photo|picture|video|base64|blob|jpeg|png|webp|media)/i;

/** First key path that looks like raw media, if any. */
export function findRawMediaField(value: unknown, path = "$"): string | null {
  if (value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findRawMediaField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_MEDIA_KEY.test(k)) return `${path}.${k}`;
    if (typeof v === "string" && /^data:(image|video)\//i.test(v)) return `${path}.${k}`;
    const hit = findRawMediaField(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

type Schemas = ReturnType<typeof buildSchemas>;
let schemaCache: Schemas | null = null;

function buildSchemas(sdk: LabSdk) {
  const e = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);
  const environment = z
    .object({
      platform: e(sdk.LAB_PLATFORMS),
      runtime: e(sdk.LAB_RUNTIMES),
      runtimeVersion: z.string().max(64).optional(),
      deviceClass: e(sdk.LAB_DEVICE_CLASSES),
      deviceModel: z.string().max(64).optional(),
      cameraFacing: e(sdk.LAB_CAMERA_FACING),
      cameraOrientation: e(sdk.LAB_CAMERA_ORIENTATIONS),
      inferenceBackend: e(sdk.LAB_INFERENCE_BACKENDS),
    })
    .strict();
  return {
    participant: z
      .object({
        phrase: z.string().max(64),
        consentVersion: z.string().max(128),
        cohort: e(sdk.LAB_PARTICIPANT_COHORTS).optional(),
      })
      .strict(),
    session: z
      .object({
        participantId: z.string().max(64),
        protocolSessionKey: z.string().min(1).max(64),
        environment,
      })
      .strict(),
    capture: z
      .object({
        sessionId: z.string().max(64),
        protocolStepKey: z.string().min(1).max(64),
        conditions: z.array(e(sdk.LAB_CAPTURE_CONDITIONS)).min(1).max(9),
        model: z
          .object({
            name: z.string().max(128),
            version: z.number().int(),
            embeddingDimensions: z.number().int(),
            detectorVersion: z.string().max(128),
            alignmentVersion: z.string().max(128),
            preprocessingVersion: z.string().max(128),
            pipelineVersion: z.string().max(128),
            normalization: z.string().max(16).optional(),
            distanceMetric: z.string().max(32).optional(),
          })
          .strict(),
        quality: z
          .object({
            decision: z.enum(["PASS", "REJECT"]),
            score: z.number().finite().optional(),
            reasons: z.array(z.string().max(64)).max(16).optional(),
          })
          .strict(),
        pad: z
          .object({
            decision: z.enum(["PASS", "REJECT", "UNAVAILABLE", "NOT_RUN"]),
            method: z.string().max(64).optional(),
            score: z.number().finite().optional(),
          })
          .strict(),
        latencyMs: z
          .object({
            detection: z.number().finite().nonnegative().optional(),
            embedding: z.number().finite().nonnegative().optional(),
            total: z.number().finite().nonnegative(),
          })
          .strict(),
        embedding: z.array(z.number()).max(4096).nullable(),
      })
      .strict(),
    pad: z
      .object({
        sessionId: z.string().max(64),
        presentation: e(sdk.LAB_PAD_PRESENTATIONS),
        padDecision: z.enum(["PASS", "REJECT", "UNAVAILABLE", "NOT_RUN"]),
        padMethod: z.string().min(1).max(64),
        challengeResult: z.enum(["PASSED", "FAILED", "TIMEOUT", "NOT_ISSUED"]),
        qualityDecision: z.enum(["PASS", "REJECT"]),
      })
      .strict(),
  };
}

async function schemas(): Promise<Schemas> {
  schemaCache ??= buildSchemas(await loadLabSdk());
  return schemaCache;
}

function badRequest(reply: FastifyReply, error: string, details?: unknown) {
  return reply.code(400).send({ error, ...(details ? { details } : {}) });
}

function logLab(event: string, meta: Record<string, unknown>) {
  console.info(JSON.stringify({ scope: "assurance_lab", event, ...meta }));
}

export async function assuranceLabRoutes(app: FastifyInstance) {
  await app.register(
    async (lab) => {
      lab.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
        const gate = assuranceLabGate();
        if (!gate.enabled) return reply.code(404).send({ error: "not_found" });
        if (!secretMatches(req.headers["x-assurance-lab-secret"], gate.secret)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      });

      lab.addHook("preValidation", async (req, reply) => {
        const hit = findRawMediaField(req.body);
        if (hit) {
          return reply.code(400).send({
            error: "RAW_MEDIA_NOT_ACCEPTED",
            message: "The Assurance Lab never accepts or stores raw images, frames, or video.",
            field: hit,
          });
        }
      });

      lab.addHook("preSerialization", async (_req, reply, payload) => {
        const sdk = await loadLabSdk();
        try {
          sdk.assertLabResponseIsolation(payload);
          return payload;
        } catch (err) {
          logLab("isolation_violation", { message: err instanceof Error ? err.message : "unknown" });
          reply.code(500);
          return { error: "assurance_lab_isolation_violation" };
        }
      });

      lab.addHook("onSend", async (_req, reply, payload) => {
        reply.removeHeader("set-cookie");
        reply.header("cache-control", "no-store");
        reply.header("x-trustid-result-kind", "EVALUATION_RESULT");
        return payload;
      });

      lab.get("/status", async () => {
        const sdk = await loadLabSdk();
        const { store, study } = await openStudy();
        const participants = store.listParticipants();
        return {
          resultKind: sdk.LAB_RESULT_KIND,
          authorityBoundary: sdk.LAB_AUTHORITY_BOUNDARY,
          productionConfiguration: productionConfigurationSnapshot(),
          productionModel: sdk.LAB_PRODUCTION_MODEL,
          lab: {
            studyId: study.studyId,
            studyVersion: study.studyVersion,
            consentVersion: study.consentVersion,
            rawImagePolicy: study.rawImagePolicy,
            evidenceRetentionDays: study.evidenceRetentionDays,
            sampleSizeRationale: study.sampleSizeRationale,
            protocol: study.sessions,
            calibrationGates: study.calibration,
            impostorSampling: study.impostorSampling,
            participants: {
              active: participants.filter((p) => p.status === "ACTIVE").length,
              withdrawn: participants.filter((p) => p.status === "WITHDRAWN").length,
            },
          },
        };
      });

      lab.get("/consent", async () => {
        const sdk = await loadLabSdk();
        const { study } = await openStudy();
        const document = sdk.buildConsentDocument(study);
        return { document, documentSha256: sha256Hex(sdk.consentDocumentText(document)) };
      });

      lab.post("/participants", async (req, reply) => {
        const sdk = await loadLabSdk();
        const parsed = (await schemas()).participant.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(reply, "invalid_request", parsed.error.issues);
        const { store, study } = await openStudy();
        const document = sdk.buildConsentDocument(study);
        const consent = sdk.validateConsentAcceptance(parsed.data, document);
        if (!consent.ok) return badRequest(reply, consent.reason);
        const now = new Date().toISOString();
        const participant = {
          participantId: newLabId("p"),
          studyId: study.studyId,
          studyVersion: study.studyVersion,
          consentVersion: document.consentVersion,
          consentedAt: now,
          consentDocumentSha256: sha256Hex(sdk.consentDocumentText(document)),
          cohort: parsed.data.cohort ?? ("GALLERY" as const),
          createdAt: now,
          status: "ACTIVE" as const,
        };
        store.saveParticipant(participant);
        logLab("participant_consented", { participantId: participant.participantId, cohort: participant.cohort });
        return reply.code(201).send({ participant });
      });

      lab.get("/participants", async () => {
        const { store, study } = await openStudy();
        return {
          participants: store.listParticipants().map((p) => {
            const sessions = store.listSessions(p.participantId);
            const captures = store.listCaptures(p.participantId);
            return {
              participantId: p.participantId,
              cohort: p.cohort,
              status: p.status,
              consentVersion: p.consentVersion,
              consentedAt: p.consentedAt,
              progress: study.sessions.map((s) => ({
                protocolSessionKey: s.key,
                sessions: sessions.filter((x) => x.protocolSessionKey === s.key).length,
                steps: s.steps.map((st) => {
                  const mine = captures.filter((c) => c.protocolSessionKey === s.key && c.protocolStepKey === st.key);
                  return {
                    key: st.key,
                    target: st.targetCaptures,
                    accepted: mine.filter((c) => c.quality.decision === "PASS").length,
                    rejected: mine.filter((c) => c.quality.decision !== "PASS").length,
                  };
                }),
              })),
            };
          }),
        };
      });

      lab.post("/participants/:participantId/withdraw", async (req, reply) => {
        const { participantId } = req.params as { participantId: string };
        if (!isLabId(participantId, "p")) return reply.code(404).send({ error: "not_found" });
        const { store } = await openStudy();
        const result = store.withdraw(participantId);
        if (!result) return reply.code(404).send({ error: "not_found" });
        logLab("participant_withdrawn", { participantId, deleted: result.deleted });
        return { withdrawal: result };
      });

      lab.post("/sessions", async (req, reply) => {
        const parsed = (await schemas()).session.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(reply, "invalid_request", parsed.error.issues);
        const { store, study } = await openStudy();
        const participant = store.getParticipant(parsed.data.participantId);
        if (!participant || participant.status !== "ACTIVE") {
          return reply.code(404).send({ error: "participant_not_found_or_withdrawn" });
        }
        const index = study.sessions.findIndex((s) => s.key === parsed.data.protocolSessionKey);
        if (index < 0) return badRequest(reply, "unknown_protocol_session");
        const now = new Date();
        const session: LabSession = {
          sessionId: newLabId("s"),
          studyId: study.studyId,
          participantId: participant.participantId,
          protocolSessionKey: parsed.data.protocolSessionKey,
          startedAt: now.toISOString(),
          environment: parsed.data.environment,
        };
        const warnings: string[] = [];
        const protocolSession = study.sessions[index]!;
        const previous = index > 0 ? study.sessions[index - 1]!.key : null;
        if (previous && protocolSession.minimumGapHoursAfterPrevious) {
          const prior = store
            .listSessions(participant.participantId)
            .filter((s) => s.protocolSessionKey === previous)
            .map((s) => Date.parse(s.startedAt));
          if (!prior.length) warnings.push(`no ${previous} session recorded yet`);
          else if (now.getTime() - Math.max(...prior) < protocolSession.minimumGapHoursAfterPrevious * 3_600_000) {
            warnings.push(`less than ${protocolSession.minimumGapHoursAfterPrevious}h after ${previous}`);
          }
        }
        store.saveSession(session);
        return reply.code(201).send({ session, protocolWarnings: warnings });
      });

      lab.post("/captures", async (req, reply) => {
        const sdk = await loadLabSdk();
        const parsed = (await schemas()).capture.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(reply, "invalid_request", parsed.error.issues);
        const { store, study } = await openStudy();
        const session = store.findSession(parsed.data.sessionId);
        if (!session) return reply.code(404).send({ error: "session_not_found" });
        const participant = store.getParticipant(session.participantId);
        if (!participant || participant.status !== "ACTIVE") {
          return reply.code(404).send({ error: "participant_not_found_or_withdrawn" });
        }
        try {
          const record = sdk.buildLabCaptureRecord(study, session, {
            ...parsed.data,
            conditions: parsed.data.conditions as LabCaptureCondition[],
            provenance: sdk.LAB_EVIDENCE_PROVENANCE.REAL_HUMAN_CONSENTED,
            captureId: newLabId("c"),
            capturedAt: new Date().toISOString(),
          });
          store.saveCapture(record);
          store.invalidateReports();
          return reply.code(201).send({ capture: sdk.toCaptureEvidence(record) });
        } catch (err) {
          if (err instanceof sdk.LabEvidenceError) return badRequest(reply, err.code, err.message);
          throw err;
        }
      });

      lab.post("/pad-attempts", async (req, reply) => {
        const sdk = await loadLabSdk();
        const parsed = (await schemas()).pad.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(reply, "invalid_request", parsed.error.issues);
        const { store, study } = await openStudy();
        const session = store.findSession(parsed.data.sessionId);
        if (!session) return reply.code(404).send({ error: "session_not_found" });
        const participant = store.getParticipant(session.participantId);
        if (!participant || participant.status !== "ACTIVE") {
          return reply.code(404).send({ error: "participant_not_found_or_withdrawn" });
        }
        const attempt = {
          schemaVersion: "trustid_assurance_lab_pad_attempt_v1" as const,
          resultKind: "EVALUATION_RESULT" as const,
          attemptId: newLabId("a"),
          studyId: study.studyId,
          participantId: participant.participantId,
          sessionId: session.sessionId,
          presentation: parsed.data.presentation,
          expected: sdk.expectedPadDecision(parsed.data.presentation),
          padDecision: parsed.data.padDecision,
          padMethod: parsed.data.padMethod,
          challengeResult: parsed.data.challengeResult,
          qualityDecision: parsed.data.qualityDecision,
          environment: session.environment,
          recordedAt: new Date().toISOString(),
          rawMediaRetained: false as const,
        };
        store.savePadAttempt(attempt);
        store.invalidateReports();
        return reply.code(201).send({ padAttempt: attempt });
      });

      lab.get("/report", async () => {
        const report = await buildLabReport();
        return { report, productionConfiguration: productionConfigurationSnapshot() };
      });

      lab.get("/export", async (_req, reply) => {
        const sdk = await loadLabSdk();
        const { store } = await openStudy();
        const { json } = sdk.buildAssuranceExport(await buildLabReport());
        store.writeReport("export.json", json);
        return reply.header("content-type", "application/json; charset=utf-8").send(json);
      });
    },
    { prefix: ASSURANCE_LAB_PREFIX },
  );
}
