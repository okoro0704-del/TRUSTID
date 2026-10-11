/**
 * Authenticated step-up contract (docs/STEP_UP_CONTRACT_V1.md).
 *
 * Client routes: OAuth bearer access token with scope identity.step_up.
 *   A TrustID session token or an id_token is not an access token and is
 *   rejected (401 invalid_token).
 * Subject routes: TrustID session (cookie or session bearer). An OAuth access
 *   token is not a session and cannot approve (401).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import { resolveAccessToken } from "../modules/authorization/service.js";
import {
  approveWithBiometric,
  approveWithMasterDevice,
  cancelStepUpChallenge,
  consumeStepUpChallenge,
  createStepUpChallenge,
  denyStepUp,
  getStepUpChallenge,
  listPendingStepUps,
  STEP_UP_METHODS,
  StepUpError,
  type ClientAccess,
} from "../modules/step-up/service.js";
import { biometricPayloadSchema } from "../modules/trust-id/schemas.js";
import {
  beginEnrollment,
  completeEnrollment,
  revokeStepUpDevice,
  stepUpDeviceStatus,
} from "../modules/step-up/master-device-enrollment.js";

const challengeParams = z.object({ challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof StepUpError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: "invalid_request", message: "Request body or parameters are invalid." });
  }
  // Passkey re-authentication failures (verifyReauthentication) carry a 4xx statusCode.
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return reply.code(status).send({ error: "reauthentication_failed", message: (err as Error).message });
  }
  throw err;
}

async function clientAccess(req: FastifyRequest, reply: FastifyReply): Promise<ClientAccess | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const access = token ? await resolveAccessToken(token) : null;
  if (!access) {
    reply.code(401).send({ error: "invalid_token", message: "A TrustID OAuth access token is required." });
    return null;
  }
  return access;
}

function parseChallengeId(req: FastifyRequest, reply: FastifyReply): string | null {
  const parsed = challengeParams.safeParse(req.params);
  if (!parsed.success) {
    reply.code(404).send({ error: "challenge_not_found", message: "Step-up challenge not found." });
    return null;
  }
  return parsed.data.challengeId;
}

export async function stepUpRoutes(app: FastifyInstance) {
  // ---- Relying party (OAuth access token) ----------------------------------

  app.post("/v1/step-up/challenges", async (req, reply) => {
    const access = await clientAccess(req, reply);
    if (!access) return;
    try {
      const body = z
        .object({
          method: z.enum(STEP_UP_METHODS),
          action: z.string(),
          operation_digest: z.string(),
          session_binding: z.string(),
          ttl_seconds: z.number().int().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const created = await createStepUpChallenge(
        access,
        {
          method: body.method,
          action: body.action,
          operationDigest: body.operation_digest,
          sessionBinding: body.session_binding,
          ttlSeconds: body.ttl_seconds,
        },
        clientMeta(req),
      );
      return reply.code(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/step-up/challenges/:challengeId", async (req, reply) => {
    const access = await clientAccess(req, reply);
    if (!access) return;
    const challengeId = parseChallengeId(req, reply);
    if (!challengeId) return;
    try {
      return await getStepUpChallenge(access, challengeId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/step-up/challenges/:challengeId/cancel", async (req, reply) => {
    const access = await clientAccess(req, reply);
    if (!access) return;
    const challengeId = parseChallengeId(req, reply);
    if (!challengeId) return;
    try {
      return await cancelStepUpChallenge(access, challengeId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/step-up/challenges/:challengeId/consume", async (req, reply) => {
    const access = await clientAccess(req, reply);
    if (!access) return;
    const challengeId = parseChallengeId(req, reply);
    if (!challengeId) return;
    try {
      const body = z
        .object({ session_binding: z.string(), operation_digest: z.string() })
        .strict()
        .parse(req.body ?? {});
      return await consumeStepUpChallenge(access, challengeId, {
        sessionBinding: body.session_binding,
        operationDigest: body.operation_digest,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Subject (TrustID session) -------------------------------------------

  app.get("/v1/step-up/pending", { preHandler: requireSession }, async (req) => {
    return { challenges: await listPendingStepUps({ userId: req.auth!.userId, sessionId: req.auth!.sessionId }) };
  });

  app.post(
    "/v1/step-up/challenges/:challengeId/master-device/approve",
    { preHandler: requireSession },
    async (req, reply) => {
      const challengeId = parseChallengeId(req, reply);
      if (!challengeId) return;
      try {
        const body = z
          .object({ device_fingerprint: z.string().min(1).max(256), signature: z.string().min(8).max(512) })
          .strict()
          .parse(req.body ?? {});
        return await approveWithMasterDevice({ userId: req.auth!.userId, sessionId: req.auth!.sessionId }, challengeId, {
          deviceFingerprint: body.device_fingerprint,
          signature: body.signature,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/step-up/challenges/:challengeId/biometric/verify",
    { preHandler: requireSession },
    async (req, reply) => {
      const challengeId = parseChallengeId(req, reply);
      if (!challengeId) return;
      try {
        const body = z.object({ biometric: biometricPayloadSchema }).strict().parse(req.body ?? {});
        return await approveWithBiometric({ userId: req.auth!.userId, sessionId: req.auth!.sessionId }, challengeId, body.biometric);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Subject: step-up Master Device enrollment ----------------------------

  app.get("/v1/step-up/master-device", { preHandler: requireSession }, async (req) => {
    return stepUpDeviceStatus(req.auth!);
  });

  app.post("/v1/step-up/master-device/enrollment", { preHandler: requireSession }, async (req, reply) => {
    try {
      const body = z.object({ public_key: z.string().min(64).max(400) }).strict().parse(req.body ?? {});
      return await beginEnrollment(req.auth!, { publicKey: body.public_key });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/step-up/master-device/enrollment/complete", { preHandler: requireSession }, async (req, reply) => {
    try {
      const body = z
        .object({
          enrollment: z.string().min(16).max(2048),
          public_key: z.string().min(64).max(400),
          device_fingerprint: z.string().min(16).max(256),
          signature: z.string().min(8).max(512),
          reauth: z.record(z.unknown()),
        })
        .strict()
        .parse(req.body ?? {});
      return await completeEnrollment(
        req.auth!,
        {
          enrollment: body.enrollment,
          publicKey: body.public_key,
          deviceFingerprint: body.device_fingerprint,
          signature: body.signature,
          reauth: body.reauth,
        },
        clientMeta(req),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/step-up/master-device/revoke", { preHandler: requireSession }, async (req, reply) => {
    try {
      const body = z
        .object({ reauth: z.record(z.unknown()), device_signature: z.string().min(8).max(512).optional() })
        .strict()
        .parse(req.body ?? {});
      return await revokeStepUpDevice(req.auth!, { reauth: body.reauth, deviceSignature: body.device_signature }, clientMeta(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/step-up/challenges/:challengeId/deny", { preHandler: requireSession }, async (req, reply) => {
    const challengeId = parseChallengeId(req, reply);
    if (!challengeId) return;
    try {
      return await denyStepUp({ userId: req.auth!.userId, sessionId: req.auth!.sessionId }, challengeId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
