import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../lib/config.js";
import {
  clearSessionCookie,
  clientMeta,
  requireSession,
  setSessionCookie,
} from "../lib/auth-context.js";
import { registerIdentity, verifyContact } from "../modules/authentication/service.js";
import {
  loginOptions,
  registrationOptions,
  verifyLogin,
  verifyRegistration,
} from "../modules/authentication/webauthn.js";
import {
  createSilentChallenge,
  pairSilentDeviceKey,
  silentAssert,
} from "../modules/authentication/silent-auth.js";
import {
  beginSilentRegistration,
  completeSilentRegistration,
} from "../modules/authentication/register-silent.js";
import {
  assertInstallAvailableForNewTrustId,
  getInstallOccupancy,
} from "../modules/authentication/device-install.js";
import { getDashboardIdentity } from "../modules/identity/service.js";
import { resolveSession, revokeSession } from "../modules/sessions/service.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string; code?: string };
  const code = e.statusCode ?? 500;
  return reply.code(code).send({
    error:
      e.code ??
      (code === 500
        ? "server_error"
        : code === 404
          ? "device_unpaired"
          : code === 401
            ? "unauthorized"
            : "invalid_request"),
    message: e.message ?? "Unexpected error",
  });
}

function sessionBody(token: string | undefined) {
  if (config.exposeSessionTokenInBody && token) {
    return { sessionToken: token };
  }
  return {};
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/install-status", async (req, reply) => {
    const body = z.object({ installId: z.string().min(1).max(80) }).parse(req.body);
    try {
      const occ = await getInstallOccupancy(body.installId);
      return { occupied: occ.occupied };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/register", async (req, reply) => {
    const body = z
      .object({
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.string().email().optional(),
        phone: z.string().min(7).max(32).optional(),
        installId: z.string().min(1).max(80).optional(),
      })
      .parse(req.body);
    try {
      if (body.installId) {
        await assertInstallAvailableForNewTrustId(body.installId);
      }
      const result = await registerIdentity({ ...body, ...clientMeta(req) });
      // Strip internal ephemeral from wire unless needed by client for session seal later
      const { _ephemeral, ...publicResult } = result;
      return {
        ...publicResult,
        // Client holds ephemerally until passkey verify seals into SessionPresentation
        presentationHint: _ephemeral,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/verify", async (req, reply) => {
    const body = z
      .object({
        challengeId: z.string().min(1),
        code: z.string().min(4).max(12),
      })
      .parse(req.body);
    try {
      return await verifyContact({ ...body, ...clientMeta(req) });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/webauthn/register/options", async (req, reply) => {
    const body = z.object({ userId: z.string().min(1) }).parse(req.body);
    try {
      return await registrationOptions(body.userId);
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/webauthn/register/verify", async (req, reply) => {
    const body = z
      .object({
        userId: z.string().min(1),
        deviceName: z.string().max(100).optional(),
        installId: z.string().min(1).max(80),
        response: z.any(),
        presentation: z
          .object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            contactType: z.string().optional(),
            contactValue: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    try {
      const result = await verifyRegistration({
        userId: body.userId,
        response: body.response,
        deviceName: body.deviceName,
        installId: body.installId,
        presentation: body.presentation
          ? {
              ...body.presentation,
              name: `${body.presentation.firstName ?? ""} ${body.presentation.lastName ?? ""}`.trim(),
            }
          : undefined,
        ...clientMeta(req),
      });
      if (!result.sessionToken) {
        throw Object.assign(new Error("Session was not created"), { statusCode: 500 });
      }
      setSessionCookie(reply, result.sessionToken);
      const identity = await getDashboardIdentity(body.userId, result.sessionId);
      return {
        trustId: result.trustId,
        profile: identity?.profile ?? null,
        device: result.device,
        sessionId: result.sessionId,
        identity,
        ...sessionBody(result.sessionToken),
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/webauthn/login/options", async (req, reply) => {
    const emptyToUndef = (v: unknown) =>
      v == null || (typeof v === "string" && v.trim() === "") ? undefined : v;
    const body = z
      .object({
        email: z.preprocess(
          emptyToUndef,
          z.string().email().optional(),
        ),
        phone: z.preprocess(emptyToUndef, z.string().optional()),
        trustId: z.preprocess(emptyToUndef, z.string().optional()),
      })
      .parse(req.body ?? {});
    try {
      return await loginOptions({
        email: body.email,
        phone: body.phone,
        trustId: body.trustId,
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/webauthn/login/verify", async (req, reply) => {
    const body = z.object({ response: z.any() }).parse(req.body);
    try {
      const result = await verifyLogin({
        response: body.response,
        ...clientMeta(req),
      });
      setSessionCookie(reply, result.sessionToken);
      const session = await resolveSession(result.sessionToken);
      if (!session) {
        throw Object.assign(new Error("Session was not created"), { statusCode: 500 });
      }
      const identity = await getDashboardIdentity(session.userId, session.id);
      return {
        trustId: result.trustId,
        profile: identity?.profile ?? null,
        device: result.device,
        sessionId: result.sessionId,
        identity,
        ...sessionBody(result.sessionToken),
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Zero-input silent challenge — no email/phone/device name. */
  app.post("/auth/silent/challenge", async (_req, reply) => {
    try {
      return await createSilentChallenge();
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /**
   * Resolve hardware public key → Trust ID Number and issue session.
   * Returns device_unpaired when the device has never completed one-time pairing.
   */
  async function handleSilentAssert(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) {
    const body = z
      .object({
        mode: z.enum(["native", "webauthn"]).default("native"),
        keyId: z.string().min(1).optional(),
        challenge: z.string().min(1).optional(),
        signature: z.string().min(1).optional(),
        response: z.any().optional(),
        device: z
          .object({
            platform: z.string().max(64).optional(),
            model: z.string().max(128).optional(),
            osVersion: z.string().max(64).optional(),
          })
          .optional(),
      })
      .parse(req.body ?? {});
    try {
      const result = await silentAssert({
        mode: body.mode,
        keyId: body.keyId,
        challenge: body.challenge,
        signature: body.signature,
        response: body.response,
        device: body.device,
        ...clientMeta(req),
      });
      setSessionCookie(reply, result.sessionToken);
      const session = await resolveSession(result.sessionToken);
      if (!session) {
        throw Object.assign(new Error("Session was not created"), { statusCode: 500 });
      }
      const identity = await getDashboardIdentity(session.userId, session.id);
      return {
        mode: result.mode,
        trustId: result.trustId,
        profile: identity?.profile ?? null,
        device: result.device,
        sessionId: result.sessionId,
        identity,
        ...sessionBody(result.sessionToken),
      };
    } catch (err) {
      return httpError(err, reply);
    }
  }

  app.post("/v1/auth/silent-assert", handleSilentAssert);
  app.post("/auth/silent/assert", handleSilentAssert);

  /**
   * Zero-PII account bootstrap — allocate $TID + discoverable passkey options.
   * Body: { installId }
   */
  app.post("/v1/auth/register-silent/options", async (req, reply) => {
    const body = z
      .object({ installId: z.string().min(1).max(80) })
      .parse(req.body ?? {});
    try {
      return await beginSilentRegistration({
        installId: body.installId,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /**
   * Complete silent registration with WebAuthn attestation.
   * Assigns $TID session with no email/phone fields.
   */
  app.post("/v1/auth/register-silent", async (req, reply) => {
    const body = z
      .object({
        userId: z.string().min(1),
        installId: z.string().min(1).max(80),
        response: z.any(),
      })
      .parse(req.body ?? {});
    try {
      const result = await completeSilentRegistration({
        userId: body.userId,
        installId: body.installId,
        response: body.response,
        ...clientMeta(req),
      });
      setSessionCookie(reply, result.sessionToken);
      return {
        ...result,
        ...sessionBody(result.sessionToken),
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** One-time pairing after an existing authenticated session. */
  app.post("/auth/silent/pair", { preHandler: requireSession }, async (req, reply) => {
    const body = z
      .object({
        keyId: z.string().min(8).max(128),
        publicKeySpki: z.string().min(16),
        algorithm: z.string().max(32).optional(),
        device: z
          .object({
            platform: z.string().max(64).optional(),
            model: z.string().max(128).optional(),
            osVersion: z.string().max(64).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    try {
      return await pairSilentDeviceKey({
        userId: req.auth!.userId,
        deviceId: req.auth!.deviceId,
        keyId: body.keyId,
        publicKeySpki: body.publicKeySpki,
        algorithm: body.algorithm,
        device: body.device,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/session", { preHandler: requireSession }, async (req) => {
    const identity = await getDashboardIdentity(
      req.auth!.userId,
      req.auth!.sessionId,
    );
    return { authenticated: true, identity, sessionId: req.auth!.sessionId };
  });

  app.post("/auth/logout", { preHandler: requireSession }, async (req, reply) => {
    await revokeSession(req.auth!.sessionId!, req.auth!.userId, clientMeta(req));
    clearSessionCookie(reply);
    return { ok: true };
  });
}
