import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../lib/auth-context.js";
import * as sync from "../modules/device-sync/service.js";

export async function deviceSyncRoutes(app: FastifyInstance) {
  app.get("/sync/devices", { preHandler: requireSession }, async (req) => {
    return sync.listSyncDevices(req.auth!.userId);
  });

  app.put("/sync/prekeys", { preHandler: requireSession }, async (req) => {
    const body = z
      .object({
        deviceId: z.string().min(1),
        bundle: z.unknown(),
      })
      .parse(req.body);
    return sync.publishPrekeyBundle({
      userId: req.auth!.userId,
      deviceId: body.deviceId,
      bundle: body.bundle,
    });
  });

  app.get(
    "/sync/prekeys/:deviceId",
    { preHandler: requireSession },
    async (req) => {
      const { deviceId } = z
        .object({ deviceId: z.string().min(1) })
        .parse(req.params);
      return sync.fetchPrekeyBundle({
        userId: req.auth!.userId,
        targetDeviceId: deviceId,
      });
    },
  );

  app.post("/sync/envelopes", { preHandler: requireSession }, async (req) => {
    const body = z
      .object({
        senderDeviceId: z.string().min(1),
        recipientDeviceId: z.string().min(1),
        envelopeType: z.enum(["vault_meta", "device_auth", "generic"]),
        header: z.record(z.unknown()),
        nonce: z.string().min(8),
        ciphertext: z.string().min(8),
        ttlHours: z.number().int().optional(),
      })
      .parse(req.body);
    return sync.queueEnvelope({
      userId: req.auth!.userId,
      senderDeviceId: body.senderDeviceId,
      body,
    });
  });

  app.get(
    "/sync/inbox/:deviceId",
    { preHandler: requireSession },
    async (req) => {
      const { deviceId } = z
        .object({ deviceId: z.string().min(1) })
        .parse(req.params);
      return {
        envelopes: await sync.listInbox({
          userId: req.auth!.userId,
          recipientDeviceId: deviceId,
        }),
      };
    },
  );

  app.post(
    "/sync/inbox/:deviceId/:envelopeId/consume",
    { preHandler: requireSession },
    async (req) => {
      const params = z
        .object({
          deviceId: z.string().min(1),
          envelopeId: z.string().min(1),
        })
        .parse(req.params);
      return sync.consumeEnvelope({
        userId: req.auth!.userId,
        recipientDeviceId: params.deviceId,
        envelopeId: params.envelopeId,
      });
    },
  );
}
