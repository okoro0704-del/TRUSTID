import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { SCOPES } from "@trustid/shared";
import { clientMeta, requireAuth, requireSession } from "../lib/auth-context.js";
import { prisma } from "../db/client.js";
import {
  deleteAvatar,
  deleteIdentityDocument,
  getAddressingProfile,
  getOwnProfile,
  saveProfile,
  setAvatar,
  submitIdentityDocument,
} from "../modules/human-profile/service.js";

function sendError(err: unknown, reply: FastifyReply) {
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: "invalid_request",
      message: err.issues[0]?.message ?? "Invalid request",
    });
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  const status = e.statusCode ?? 500;
  return reply.code(status).send({
    error: e.code ?? (status === 500 ? "server_error" : "invalid_request"),
    message: status === 500 ? "Unexpected error" : e.message,
  });
}

const avatarBody = z.object({ imageDataUrl: z.string().min(32) }).strict();
/** The addressing interface never takes a subject from the caller. */
const noSubjectSelector = z.object({}).strict();

/**
 * Human Profile V1. Owner endpoints are first-party session only (never OAuth
 * bearer). Identity documents are never returned by any endpoint here.
 */
export async function profileRoutes(app: FastifyInstance) {
  app.get("/v1/profile", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await getOwnProfile(req.auth!.userId);
    } catch (err) {
      return sendError(err, reply);
    }
  });

  app.put("/v1/profile", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await saveProfile({ userId: req.auth!.userId, ...clientMeta(req) }, req.body);
    } catch (err) {
      return sendError(err, reply);
    }
  });

  app.put(
    "/v1/profile/avatar",
    { preHandler: requireSession, bodyLimit: 3 * 1024 * 1024 },
    async (req, reply) => {
      try {
        const { imageDataUrl } = avatarBody.parse(req.body);
        return await setAvatar({ userId: req.auth!.userId, ...clientMeta(req) }, imageDataUrl);
      } catch (err) {
        return sendError(err, reply);
      }
    },
  );

  app.delete("/v1/profile/avatar", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await deleteAvatar({ userId: req.auth!.userId, ...clientMeta(req) });
    } catch (err) {
      return sendError(err, reply);
    }
  });

  app.post(
    "/v1/profile/documents",
    { preHandler: requireSession, bodyLimit: 7 * 1024 * 1024 },
    async (req, reply) => {
      try {
        const result = await submitIdentityDocument({ userId: req.auth!.userId, ...clientMeta(req) }, req.body);
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(err, reply);
      }
    },
  );

  app.delete("/v1/profile/documents/:id", { preHandler: requireSession }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      return await deleteIdentityDocument({ userId: req.auth!.userId, ...clientMeta(req) }, id);
    } catch (err) {
      return sendError(err, reply);
    }
  });

  /**
   * Minimal addressing profile (Digi AI). Subject = the authenticated session
   * user, or the OAuth access token's subject with identity.addressing granted.
   */
  app.get("/v1/profile/addressing", { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (!noSubjectSelector.safeParse(req.query ?? {}).success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "The subject comes from authentication only",
        });
      }
      let audience = req.auth!.userId;
      if (req.auth!.via === "bearer" && req.auth!.applicationId) {
        if (!(req.auth!.scopes ?? []).includes(SCOPES.IDENTITY_ADDRESSING)) {
          return reply.code(403).send({ error: "insufficient_scope", message: "identity.addressing not granted" });
        }
        const client = await prisma.application.findUnique({
          where: { id: req.auth!.applicationId },
          select: { clientId: true },
        });
        audience = client?.clientId ?? "oauth_client";
      }
      return await getAddressingProfile(req.auth!.userId, audience);
    } catch (err) {
      return sendError(err, reply);
    }
  });
}
