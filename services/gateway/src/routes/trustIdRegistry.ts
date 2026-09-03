import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../../../../apps/api/src/db/client.js";
import { ambientSignInAndSession } from "../../../../../apps/api/src/modules/trust-id/fusion.js";
import { createDeviceApprovalRequest } from "../../../../../apps/api/src/modules/device-approval/service.js";

const FACE_DIMS = 512;
const DEFAULT_THRESHOLD = 0.14; // cosine distance: lower is better

const faceVectorSchema = z.array(z.number()).length(FACE_DIMS);

const identifySchema = z.object({
  installId: z.string().min(1).max(80).optional(),
  face: z.object({
    vector: faceVectorSchema,
    confidence: z.number().min(0).max(1).optional(),
    modelName: z.string().max(64).optional(),
    modelVersion: z.number().int().positive().optional(),
  }),
  liveness: z.object({
    score: z.number().min(0).max(1),
    passed: z.boolean(),
  }),
});

const enrollSchema = identifySchema.extend({
  trustId: z.string().min(1).optional(),
  allowCreateIfNoMatch: z.boolean().optional().default(true),
});

function toVectorLiteral(v: number[]) {
  return `[${v.map((n) => Number(n).toFixed(8)).join(",")}]`;
}

async function bestFaceMatch(vector: number[]) {
  const literal = toVectorLiteral(vector);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      user_id: string;
      trust_id: string;
      embedding_id: string;
      distance: number;
    }>
  >(
    `
    SELECT
      user_id,
      trust_id,
      id AS embedding_id,
      (vector <=> '${literal}'::vector) AS distance
    FROM portal.biometric_vectors
    WHERE modality = 'face' AND status = 'active'
    ORDER BY vector <=> '${literal}'::vector
    LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function trustIdRegistryRoutes(app: FastifyInstance) {
  app.post("/v1/trust-id/registry/identify", async (req, reply) => {
    const body = identifySchema.parse(req.body ?? {});
    if (!body.liveness.passed || body.liveness.score < 0.62) {
      return reply.code(401).send({
        error: "liveness_failed",
        message: "Liveness check failed. Keep your face in frame and try again.",
      });
    }

    const hit = await bestFaceMatch(body.face.vector);
    if (!hit || Number(hit.distance) > DEFAULT_THRESHOLD) {
      return reply.code(401).send({
        error: "face_not_recognized",
        message: "No existing Trust ID matched this face.",
      });
    }

    const ambient = await ambientSignInAndSession({
      payload: {
        face: {
          modality: "face",
          vector: body.face.vector,
          confidence: body.face.confidence,
          modelName: body.face.modelName,
          modelVersion: body.face.modelVersion,
        },
      },
      installId: body.installId,
      allowAutoEnroll: false,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    if (!ambient.matched) {
      return reply.code(401).send({
        error: "face_not_recognized",
        message: ambient.error ?? "Face matched registry probe but not auth engine.",
      });
    }

    if (ambient.needsMasterApproval && ambient.trustId) {
      return reply.code(202).send({
        status: "PENDING_MASTER_APPROVAL",
        trustId: ambient.trustId,
        approvalPollToken: ambient.approvalPollToken,
        approvalRequestId: ambient.approvalRequestId,
      });
    }

    return reply.send({
      status: "APPROVED",
      trustId: ambient.trustId,
      sessionToken: ambient.sessionToken,
      identity: ambient.identity,
    });
  });

  app.post("/v1/trust-id/registry/enroll", async (req, reply) => {
    const body = enrollSchema.parse(req.body ?? {});
    if (!body.liveness.passed || body.liveness.score < 0.62) {
      return reply.code(401).send({
        error: "liveness_failed",
        message: "Liveness check failed. Enrollment blocked.",
      });
    }

    const hit = await bestFaceMatch(body.face.vector);
    if (hit && Number(hit.distance) <= DEFAULT_THRESHOLD) {
      return reply.code(409).send({
        error: "duplicate_face",
        message: `This face already belongs to ${hit.trust_id}.`,
        trustId: hit.trust_id,
      });
    }

    if (!body.allowCreateIfNoMatch) {
      return reply.code(404).send({
        error: "no_match_create_disabled",
        message: "No existing face match and account creation is disabled.",
      });
    }

    const ambient = await ambientSignInAndSession({
      payload: {
        face: {
          modality: "face",
          vector: body.face.vector,
          confidence: body.face.confidence,
          modelName: body.face.modelName,
          modelVersion: body.face.modelVersion,
        },
      },
      installId: body.installId,
      allowAutoEnroll: true,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    if (!ambient.matched) {
      return reply.code(401).send({
        error: "enroll_blocked",
        message: ambient.error ?? "Enrollment failed.",
      });
    }

    return reply.code(201).send({
      status: ambient.enrolled ? "ENROLLED" : "APPROVED",
      trustId: ambient.trustId,
      sessionToken: ambient.sessionToken,
      identity: ambient.identity,
      needsMasterApproval: ambient.needsMasterApproval ?? false,
    });
  });

  app.post("/v1/trust-id/registry/master-approval/request", async (req, reply) => {
    const body = z
      .object({
        trustId: z.string().min(1),
        deviceName: z.string().min(1).max(80).optional(),
      })
      .parse(req.body ?? {});

    const approval = await createDeviceApprovalRequest({
      trustId: body.trustId,
      deviceName: body.deviceName ?? "Unrecognized device",
      applicationName: "TrustID",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return reply.code(202).send({
      status: "PENDING_MASTER_APPROVAL",
      ...approval,
    });
  });
}
