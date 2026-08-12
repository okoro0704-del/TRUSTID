import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../lib/auth-context.js";
import * as recovery from "../modules/recovery/service.js";

export async function recoveryRoutes(app: FastifyInstance) {
  app.get("/recovery/status", { preHandler: requireSession }, async (req) => {
    return recovery.getGuardianCircleStatus(req.auth!.userId);
  });

  app.post(
    "/recovery/guardians/circle",
    { preHandler: requireSession },
    async (req) => {
      return recovery.createGuardianCircle({
        userId: req.auth!.userId,
        body: req.body,
      });
    },
  );

  app.delete(
    "/recovery/guardians/circle",
    { preHandler: requireSession },
    async (req) => {
      return recovery.revokeGuardianCircle(req.auth!.userId);
    },
  );

  /** Public claim  invite code is the capability (no session). */
  app.post("/recovery/guardians/claim", async (req) => {
    const body = z.object({ inviteCode: z.string().min(8) }).parse(req.body);
    return recovery.claimGuardianShare(body);
  });

  app.post(
    "/recovery/guardians/session",
    { preHandler: requireSession },
    async (req) => {
      return recovery.startRecoverySession(req.auth!.userId);
    },
  );

  app.post(
    "/recovery/guardians/session/:sessionId/share",
    { preHandler: requireSession },
    async (req) => {
      const params = z.object({ sessionId: z.string().min(1) }).parse(req.params);
      const body = z
        .object({
          shareIndex: z.number().int().min(1).max(255),
          shareCommitment: z.string().optional(),
        })
        .parse(req.body);
      return recovery.submitRecoveryShareIndex({
        userId: req.auth!.userId,
        sessionId: params.sessionId,
        shareIndex: body.shareIndex,
        shareCommitment: body.shareCommitment,
      });
    },
  );
}
