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
import {
  listTemporaryDevices,
  terminateTemporaryDevice,
} from "../modules/device-approval/service.js";
import { promoteDeviceToPrimary } from "../modules/devices/trust.js";
import {
  approveEnrollment,
  claimEnrollment,
  completeEnrollment,
  createEnrollmentInvite,
  getEnrollmentByCode,
  resolveEnrollmentUser,
} from "../modules/devices/enrollment.js";
import { WEBAUTHN_PURPOSES } from "@trustid/shared";
import {
  registrationOptions,
  verifyAdditionalDevice,
  verifyRegistration,
} from "../modules/authentication/webauthn.js";
import { setSessionCookie } from "../lib/auth-context.js";

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
    return listDevices(req.auth!.userId, req.auth!.deviceId);
  });

  app.get("/devices/temporary", { preHandler: requireSession }, async (req) => {
    return listTemporaryDevices(req.auth!.userId);
  });

  app.delete("/devices/temporary/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    try {
      return await terminateTemporaryDevice(
        req.auth!.userId,
        params.id,
        clientMeta(req),
      );
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.get("/devices/:id", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const devices = await listDevices(req.auth!.userId, req.auth!.deviceId);
    const device = devices.find((d) => d.id === params.id);
    if (!device) {
      return reply.code(404).send({ error: "not_found", message: "Device not found" });
    }
    return device;
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
    const body = z
      .object({ response: z.any().optional() })
      .parse(req.body ?? {});
    try {
      if (!body.response) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "WebAuthn verification required to revoke a device",
        });
      }
      const { verifyReauthentication } = await import(
        "../modules/authentication/webauthn.js"
      );
      await verifyReauthentication({
        userId: req.auth!.userId,
        deviceId: req.auth!.deviceId ?? undefined,
        response: body.response,
        ...clientMeta(req),
      });
      await revokeDevice(req.auth!.userId, params.id, clientMeta(req), {
        actorDeviceId: req.auth!.deviceId,
        requirePrimary: true,
      });
      return { ok: true };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/devices/:id/promote", { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ response: z.any() }).parse(req.body);
    try {
      const device = await promoteDeviceToPrimary({
        userId: req.auth!.userId,
        actorDeviceId: req.auth!.deviceId,
        targetDeviceId: params.id,
        response: body.response,
        ...clientMeta(req),
      });
      return {
        id: device.id,
        name: device.name,
        trustLevel: device.trustLevel,
      };
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

  // --- Enrollment (QR / pairing code) ---

  app.post("/devices/enrollment", { preHandler: requireSession }, async (req) => {
    const invite = await createEnrollmentInvite(req.auth!.userId, {
      ...clientMeta(req),
      deviceId: req.auth!.deviceId,
    });
    return invite;
  });

  app.get("/devices/enrollment/:code", async (req, reply) => {
    const params = z.object({ code: z.string().min(4).max(12) }).parse(req.params);
    try {
      return await getEnrollmentByCode(params.code);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post(
    "/devices/enrollment/:id/approve",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      try {
        return await approveEnrollment(
          req.auth!.userId,
          params.id,
          req.auth!.deviceId ?? undefined,
        );
      } catch (err) {
        return httpError(err, reply);
      }
    },
  );

  app.post("/devices/enrollment/:code/claim", async (req, reply) => {
    const params = z.object({ code: z.string().min(4).max(12) }).parse(req.params);
    const body = z
      .object({ deviceName: z.string().max(100).optional() })
      .parse(req.body ?? {});
    try {
      const result = await claimEnrollment(params.code, {
        ...clientMeta(req),
        deviceName: body.deviceName,
      });
      if (result.sessionToken) setSessionCookie(reply, result.sessionToken);
      return result;
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/devices/enrollment/register/options", async (req, reply) => {
    const body = z.object({ enrollmentToken: z.string().min(10) }).parse(req.body);
    try {
      const row = await resolveEnrollmentUser(body.enrollmentToken);
      return await registrationOptions(row.userId, WEBAUTHN_PURPOSES.DEVICE_ADDITION);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/devices/enrollment/register/verify", async (req, reply) => {
    const body = z
      .object({
        enrollmentToken: z.string().min(10),
        deviceName: z.string().max(100).optional(),
        response: z.any(),
      })
      .parse(req.body);
    try {
      const row = await resolveEnrollmentUser(body.enrollmentToken);
      const result = await verifyRegistration({
        userId: row.userId,
        response: body.response,
        deviceName: body.deviceName,
        purpose: WEBAUTHN_PURPOSES.DEVICE_ADDITION,
        ...clientMeta(req),
      });
      await completeEnrollment(row.id, row.userId);
      if (result.sessionToken) setSessionCookie(reply, result.sessionToken);
      return {
        device: result.device,
        trustId: result.trustId,
        sessionId: result.sessionId,
        sessionToken: result.sessionToken,
      };
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
        const updated = await approveEnrollment(
          req.auth!.userId,
          params.id,
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
