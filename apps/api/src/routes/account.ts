import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AUDIT_EVENTS } from "@trustid/shared";
import { clientMeta, requireSession } from "../lib/auth-context.js";
import { prisma } from "../db/client.js";
import { commitName } from "../lib/crypto.js";
import { recordAudit } from "../modules/audit/service.js";
import {
  openSessionPresentation,
  sealSessionPresentation,
} from "../modules/sessions/presentation.js";

export async function accountRoutes(app: FastifyInstance) {
  app.get("/account/preferences", { preHandler: requireSession }, async (req) => {
    const prefs = await prisma.accountPreferences.upsert({
      where: { userId: req.auth!.userId },
      create: { userId: req.auth!.userId },
      update: {},
    });
    const presentation = req.auth!.sessionId
      ? await openSessionPresentation(req.auth!.sessionId)
      : null;
    return {
      profile: presentation
        ? {
            firstName: presentation.firstName ?? "",
            lastName: presentation.lastName ?? "",
          }
        : null,
      theme: prefs.theme,
      notificationsEnabled: prefs.notificationsEnabled,
      privacyShareAnalytics: prefs.privacyShareAnalytics,
      language: prefs.language,
      zeroPii: true,
    };
  });

  app.patch("/account/preferences", { preHandler: requireSession }, async (req) => {
    const body = z
      .object({
        theme: z.enum(["system", "dark", "light"]).optional(),
        notificationsEnabled: z.boolean().optional(),
        privacyShareAnalytics: z.boolean().optional(),
        language: z.string().min(2).max(10).optional(),
        firstName: z.string().min(1).max(100).optional(),
        lastName: z.string().min(1).max(100).optional(),
      })
      .parse(req.body);

    if ((body.firstName || body.lastName) && req.auth!.sessionId) {
      const existing = await openSessionPresentation(req.auth!.sessionId);
      const firstName = body.firstName?.trim() ?? existing?.firstName ?? "";
      const lastName = body.lastName?.trim() ?? existing?.lastName ?? "";
      const nameCommit = commitName(firstName, lastName);
      await prisma.profile.upsert({
        where: { userId: req.auth!.userId },
        create: {
          userId: req.auth!.userId,
          nameCommitment: nameCommit.nameCommitment,
          nameSalt: nameCommit.nameSalt,
        },
        update: {
          nameCommitment: nameCommit.nameCommitment,
          nameSalt: nameCommit.nameSalt,
        },
      });
      const session = await prisma.session.findUnique({
        where: { id: req.auth!.sessionId },
      });
      if (session) {
        await sealSessionPresentation(
          session.id,
          {
            ...existing,
            firstName,
            lastName,
            name: `${firstName} ${lastName}`.trim(),
          },
          session.expiresAt,
        );
      }
    }

    const prefs = await prisma.accountPreferences.upsert({
      where: { userId: req.auth!.userId },
      create: {
        userId: req.auth!.userId,
        theme: body.theme ?? "system",
        notificationsEnabled: body.notificationsEnabled ?? true,
        privacyShareAnalytics: body.privacyShareAnalytics ?? false,
        language: body.language ?? "en",
      },
      update: {
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.notificationsEnabled !== undefined
          ? { notificationsEnabled: body.notificationsEnabled }
          : {}),
        ...(body.privacyShareAnalytics !== undefined
          ? { privacyShareAnalytics: body.privacyShareAnalytics }
          : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
      },
    });

    await recordAudit({
      type: AUDIT_EVENTS.SECURITY_SETTINGS_CHANGED,
      userId: req.auth!.userId,
      actorType: "user",
      actorId: req.auth!.userId,
      metadata: { changed: Object.keys(body) },
      ...clientMeta(req),
    });

    return {
      theme: prefs.theme,
      notificationsEnabled: prefs.notificationsEnabled,
      privacyShareAnalytics: prefs.privacyShareAnalytics,
      language: prefs.language,
    };
  });

  app.get("/account/identity-verification", { preHandler: requireSession }, async (req) => {
    const { getIdentityVerificationSummary } = await import(
      "../modules/identity-verification/service.js"
    );
    const { getVerifiedIdentityProfileView } = await import(
      "../modules/verified-identity/profile.js"
    );
    const summary = await getIdentityVerificationSummary(req.auth!.userId);
    const vip = await getVerifiedIdentityProfileView(req.auth!.userId);
    return {
      status: vip.isVerifiedIdentity ? "Verified" : "Not Verified",
      statusCode: summary.status,
      identityStatus: vip.identityStatus,
      verificationLevel: vip.verificationLevel,
      hasVerifiedIdentityPortrait: vip.hasVerifiedIdentityPortrait,
      isMock: summary.isMock,
      futureProvider: summary.isMock ? "Mock (dev only)" : "Provider configurable",
      provider: summary.provider,
      method: summary.method,
      verifiedAt: summary.verifiedAt,
      note: vip.disclaimer,
    };
  });
}
