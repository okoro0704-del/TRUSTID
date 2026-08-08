import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  clientMeta,
  requireAuth,
  requireSession,
} from "../lib/auth-context.js";
import {
  getDashboardIdentity,
  getIdentityForUser,
} from "../modules/identity/service.js";
import {
  completeIdentityVerification,
  startIdentityVerification,
} from "../modules/identity-verification/service.js";
import {
  getJwks,
  issueIdentityAssertion,
  verifyIdentityAssertion,
} from "../modules/verified-identity/assertions.js";
import {
  createImpersonationReport,
  listOwnImpersonationReports,
} from "../modules/verified-identity/impersonation.js";
import {
  createMediaAccessToken,
  readPrivateBytes,
  verifyMediaAccessToken,
} from "../modules/verified-identity/media.js";
import {
  decodeDataUrlImage,
  getPortraitForOwner,
  getVerifiedPortraitForAudience,
  revokeVerifiedPortrait,
  uploadIdentityPortrait,
} from "../modules/verified-identity/portrait.js";
import { getVerifiedIdentityProfileView } from "../modules/verified-identity/profile.js";
import { prisma } from "../db/client.js";
import { SCOPES } from "@trustid/shared";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string; code?: string };
  const code = e.statusCode ?? 500;
  return reply.code(code).send({
    error: e.code || (code === 500 ? "server_error" : "invalid_request"),
    message: e.message ?? "Unexpected error",
  });
}

export async function identityRoutes(app: FastifyInstance) {
  app.get("/identity", { preHandler: requireAuth }, async (req) => {
    if (req.auth!.via === "bearer") {
      return getIdentityForUser(req.auth!.userId, req.auth!.scopes);
    }
    return getDashboardIdentity(req.auth!.userId);
  });

  app.get("/identity/profile", { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.auth!.via === "bearer") {
        const scopes = req.auth!.scopes ?? [];
        const allowStatus =
          scopes.includes(SCOPES.IDENTITY_VERIFICATION_STATUS) ||
          scopes.includes(SCOPES.IDENTITY_BASIC) ||
          scopes.includes(SCOPES.OPENID);
        if (!allowStatus) {
          return reply.code(403).send({
            error: "forbidden",
            message: "Missing identity.verification_status scope",
          });
        }
      }
      return await getVerifiedIdentityProfileView(req.auth!.userId);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/identity/portrait", { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.auth!.via === "bearer") {
        const scopes = req.auth!.scopes ?? [];
        if (!scopes.includes(SCOPES.IDENTITY_PORTRAIT)) {
          return reply.code(403).send({
            error: "forbidden",
            message: "Missing identity.portrait scope",
          });
        }
        const appId = req.auth!.applicationId;
        const app = appId
          ? await prisma.application.findUnique({ where: { id: appId } })
          : null;
        return await getVerifiedPortraitForAudience({
          subjectUserId: req.auth!.userId,
          audience: app?.clientId ?? "oauth_client",
        });
      }
      const q = z
        .object({ portraitId: z.string().optional() })
        .parse(req.query ?? {});
      const portrait = await getPortraitForOwner(req.auth!.userId, q.portraitId);
      if (!portrait) {
        return reply.code(404).send({
          error: "not_found",
          message: "No portrait uploaded",
        });
      }
      return portrait;
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/identity/portrait", { preHandler: requireSession }, async (req, reply) => {
    try {
      const body = z
        .object({
          imageDataUrl: z.string().min(32).max(4_000_000).optional(),
          imageBase64: z.string().min(32).max(4_000_000).optional(),
          mimeType: z.string().optional(),
        })
        .parse(req.body ?? {});

      let mimeType: string;
      let bytes: Buffer;
      if (body.imageDataUrl) {
        ({ mimeType, bytes } = decodeDataUrlImage(body.imageDataUrl));
      } else if (body.imageBase64 && body.mimeType) {
        mimeType = body.mimeType;
        bytes = Buffer.from(body.imageBase64, "base64");
      } else {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Provide imageDataUrl or imageBase64+mimeType",
        });
      }

      return await uploadIdentityPortrait({
        userId: req.auth!.userId,
        bytes,
        mimeType,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post(
    "/identity/portrait/revoke",
    { preHandler: requireSession },
    async (req, reply) => {
      try {
        const body = z
          .object({ reason: z.string().min(3).max(500) })
          .parse(req.body ?? {});
        await revokeVerifiedPortrait({
          userId: req.auth!.userId,
          reason: body.reason,
          ...clientMeta(req),
        });
        return { ok: true };
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post(
    "/identity/verification/start",
    { preHandler: requireSession },
    async (req, reply) => {
      try {
        const body = z
          .object({
            portraitId: z.string().min(1),
            method: z.string().optional(),
          })
          .parse(req.body ?? {});
        return await startIdentityVerification({
          userId: req.auth!.userId,
          portraitId: body.portraitId,
          method: body.method,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post(
    "/identity/verification/complete",
    { preHandler: requireSession },
    async (req, reply) => {
      try {
        const body = z
          .object({
            verificationId: z.string().min(1),
            providerPayload: z.record(z.unknown()).optional(),
          })
          .parse(req.body ?? {});
        return await completeIdentityVerification({
          userId: req.auth!.userId,
          verificationId: body.verificationId,
          providerPayload: body.providerPayload,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post(
    "/identity/assertions",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const body = z
          .object({
            audience: z.string().min(2).max(200),
            ttlSeconds: z.number().int().min(30).max(3600).optional(),
          })
          .parse(req.body ?? {});
        return await issueIdentityAssertion({
          userId: req.auth!.userId,
          audience: body.audience,
          scopes: req.auth!.scopes,
          ttlSeconds: body.ttlSeconds,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post("/identity/assertions/verify", async (req, reply) => {
    try {
      const body = z
        .object({
          assertion: z.string().min(20),
          audience: z.string().min(2),
          consume: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      return await verifyIdentityAssertion({
        assertion: body.assertion,
        expectedAudience: body.audience,
        consumeJti: body.consume ?? false,
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/.well-known/jwks.json", async () => getJwks());

  app.post(
    "/identity/impersonation-reports",
    { preHandler: requireSession },
    async (req, reply) => {
      try {
        const body = z
          .object({
            type: z.string(),
            reason: z.string().min(5).max(2000),
            subjectTrustId: z.string().optional(),
            evidenceNote: z.string().max(2000).optional(),
          })
          .parse(req.body ?? {});
        return await createImpersonationReport({
          reporterUserId: req.auth!.userId,
          type: body.type,
          reason: body.reason,
          subjectTrustId: body.subjectTrustId,
          evidenceNote: body.evidenceNote,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.get(
    "/identity/impersonation-reports",
    { preHandler: requireSession },
    async (req) => listOwnImpersonationReports(req.auth!.userId),
  );

  /** Access-controlled media — requires valid HMAC token (no public buckets). */
  app.get("/identity/media/:mediaId", async (req, reply) => {
    try {
      const params = z.object({ mediaId: z.string() }).parse(req.params);
      const q = z.object({ token: z.string() }).parse(req.query ?? {});
      const claims = verifyMediaAccessToken(q.token);
      if (claims.mediaId !== params.mediaId) {
        return reply.code(403).send({ error: "forbidden", message: "Token mismatch" });
      }
      const media = await prisma.identityMediaObject.findFirst({
        where: { id: params.mediaId, userId: claims.userId, deletedAt: null },
      });
      if (!media) {
        return reply.code(404).send({ error: "not_found", message: "Media not found" });
      }
      const bytes = await readPrivateBytes(media.storageKey);
      return reply
        .header("Content-Type", media.mimeType)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  // silence unused import warning for createMediaAccessToken if tree-shaken oddly
  void createMediaAccessToken;
}
