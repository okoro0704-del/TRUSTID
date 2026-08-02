import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import {
  createPairingRequest,
  listDevices,
  listPairingRequests,
  renameDevice,
  resolvePairingRequest,
  revokeDevice,
} from "../modules/devices/service.js";
import { WEBAUTHN_PURPOSES } from "@trustid/shared";
import {
  registrationOptions,
  verifyAdditionalDevice,
} from "../modules/authentication/webauthn.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string };
  const code = e.statusCode ?? 500;
  return reply.code(code).send({
    error: "invalid_request",
    message: e.message ?? "Unexpected error",
  });
}

export async function deviceRoutes(app: FastifyInstance) {
  app.get("/devices", { preHandler: requireSession }, async (req) => {
    return listDevices(req.auth!.userId);
  });

  app.patch("/devices/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    try {
      const device = await renameDevice(req.auth!.userId, params.id, body.name);
      return { id: device.id, name: device.name, status: device.status };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.delete("/devices/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    try {
      await revokeDevice(req.auth!.userId, params.id, clientMeta(req));
      return { ok: true };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/devices/register/options", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await registrationOptions(
        req.auth!.userId,
        WEBAUTHN_PURPOSES.DEVICE_ADDITION,
      );
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/devices/register/verify", { preHandler: requireSession }, async (req, reply) => {
    const body = z
      .object({
        deviceName: z.string().max(100).optional(),
        response: z.any(),
      })
      .parse(req.body);
    try {
      const result = await verifyAdditionalDevice({
        userId: req.auth!.userId,
        response: body.response,
        deviceName: body.deviceName,
        ...clientMeta(req),
      });
      return { device: result.device, trustId: result.trustId };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/devices/pairing-requests", { preHandler: requireSession }, async (req) => {
    const body = z
      .object({
        name: z.string().optional(),
        platform: z.string().optional(),
        userAgent: z.string().optional(),
        location: z.string().optional(),
      })
      .parse(req.body ?? {});
    return createPairingRequest(req.auth!.userId, {
      ...body,
      userAgent: body.userAgent ?? req.headers["user-agent"],
      time: new Date().toISOString(),
    });
  });

  app.get("/devices/pairing-requests", { preHandler: requireSession }, async (req) => {
    return listPairingRequests(req.auth!.userId);
  });

  app.post(
    "/devices/pairing-requests/:id/approve",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      try {
        const updated = await resolvePairingRequest(
          req.auth!.userId,
          params.id,
          "approve",
          req.auth!.deviceId ?? undefined,
        );
        return { id: updated.id, status: updated.status };
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post(
    "/devices/pairing-requests/:id/reject",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      try {
        const updated = await resolvePairingRequest(
          req.auth!.userId,
          params.id,
          "reject",
        );
        return { id: updated.id, status: updated.status };
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );
}
