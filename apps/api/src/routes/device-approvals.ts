import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WEBAUTHN_PURPOSES } from "@trustid/shared";
import {
  clientMeta,
  requireSession,
  setSessionCookie,
} from "../lib/auth-context.js";
import { config } from "../lib/config.js";
import {
  approveTemporaryAccess,
  approveTrustDevice,
  claimApprovalResult,
  completeApprovalEnrollment,
  createDeviceApprovalRequest,
  declineApproval,
  getApprovalStatusByPollToken,
  listApprovals,
  listPendingApprovals,
  resolveApprovalEnrollment,
} from "../modules/device-approval/service.js";
import {
  listSecurityNotifications,
  markNotificationRead,
  unreadNotificationCount,
} from "../modules/notifications/service.js";
import {
  registrationOptions,
  reauthenticationOptions,
  verifyRegistration,
} from "../modules/authentication/webauthn.js";
import { getDashboardIdentity } from "../modules/identity/service.js";
import { getRecoveryArchitectureNotes } from "../modules/recovery/types.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string };
  return reply.code(e.statusCode ?? 500).send({
    error: "invalid_request",
    message: e.message ?? "Unexpected error",
  });
}

export async function deviceApprovalRoutes(app: FastifyInstance) {
  // --- Requesting (unknown) device ---

  app.post("/device-approvals", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email().optional(),
        phone: z.string().min(7).max(32).optional(),
        trustId: z.string().min(4).optional(),
        deviceName: z.string().max(100).optional(),
        clientId: z.string().optional(),
        applicationName: z.string().max(100).optional(),
        location: z.string().max(200).optional(),
      })
      .refine((b) => b.email || b.phone || b.trustId, {
        message: "email, phone, or trustId required",
      })
      .parse(req.body);
    try {
      return await createDeviceApprovalRequest({
        ...body,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/device-approvals/poll/:token", async (req, reply) => {
    const params = z.object({ token: z.string().min(10) }).parse(req.params);
    try {
      return await getApprovalStatusByPollToken(params.token);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/device-approvals/claim", async (req, reply) => {
    const body = z.object({ pollToken: z.string().min(10) }).parse(req.body);
    try {
      const result = await claimApprovalResult(body.pollToken);
      if (result.mode === "temporary" && result.sessionToken) {
        setSessionCookie(reply, result.sessionToken);
        const identity = await getDashboardIdentity(
          result.userId,
          result.sessionId,
        );
        const { sessionToken, ...rest } = result;
        return {
          ...rest,
          identity,
          ...(config.exposeSessionTokenInBody ? { sessionToken } : {}),
        };
      }
      return result;
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/device-approvals/register/options", async (req, reply) => {
    const body = z.object({ enrollmentToken: z.string().min(10) }).parse(req.body);
    try {
      const row = await resolveApprovalEnrollment(body.enrollmentToken);
      return await registrationOptions(row.userId, WEBAUTHN_PURPOSES.DEVICE_ADDITION);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/device-approvals/register/verify", async (req, reply) => {
    const body = z
      .object({
        enrollmentToken: z.string().min(10),
        deviceName: z.string().max(100).optional(),
        response: z.any(),
      })
      .parse(req.body);
    try {
      const row = await resolveApprovalEnrollment(body.enrollmentToken);
      const result = await verifyRegistration({
        userId: row.userId,
        response: body.response,
        deviceName: body.deviceName ?? row.requestedDeviceName,
        purpose: WEBAUTHN_PURPOSES.DEVICE_ADDITION,
        ...clientMeta(req),
      });
      await completeApprovalEnrollment(row.id, row.userId, result.device.id);
      if (result.sessionToken) setSessionCookie(reply, result.sessionToken);
      const identity = await getDashboardIdentity(row.userId, result.sessionId);
      return {
        device: result.device,
        trustId: result.trustId,
        sessionId: result.sessionId,
        identity,
        ...(config.exposeSessionTokenInBody && result.sessionToken
          ? { sessionToken: result.sessionToken }
          : {}),
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  // --- Primary trusted device ---

  app.get("/device-approvals/pending", { preHandler: requireSession }, async (req) => {
    return listPendingApprovals(req.auth!.userId);
  });

  app.get("/device-approvals", { preHandler: requireSession }, async (req) => {
    return listApprovals(req.auth!.userId);
  });

  app.post(
    "/device-approvals/:id/approve",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ response: z.any() }).parse(req.body);
      try {
        return await approveTrustDevice({
          userId: req.auth!.userId,
          deviceId: req.auth!.deviceId,
          requestId: params.id,
          response: body.response,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post(
    "/device-approvals/:id/temporary",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ response: z.any() }).parse(req.body);
      try {
        return await approveTemporaryAccess({
          userId: req.auth!.userId,
          deviceId: req.auth!.deviceId,
          requestId: params.id,
          response: body.response,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post(
    "/device-approvals/:id/decline",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ response: z.any() }).parse(req.body);
      try {
        return await declineApproval({
          userId: req.auth!.userId,
          deviceId: req.auth!.deviceId,
          requestId: params.id,
          response: body.response,
          ...clientMeta(req),
        });
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.get("/notifications", { preHandler: requireSession }, async (req) => {
    const [items, unread] = await Promise.all([
      listSecurityNotifications(req.auth!.userId),
      unreadNotificationCount(req.auth!.userId),
    ]);
    return { items, unread };
  });

  app.post("/notifications/:id/read", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    try {
      await markNotificationRead(req.auth!.userId, params.id);
      return { ok: true };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/recovery/status", { preHandler: requireSession }, async () => {
    return getRecoveryArchitectureNotes();
  });
}

export async function reauthRoutes(app: FastifyInstance) {
  app.post("/auth/webauthn/reauth/options", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reauthenticationOptions(req.auth!.userId, req.auth!.deviceId);
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
