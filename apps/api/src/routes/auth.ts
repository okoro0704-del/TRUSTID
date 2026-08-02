import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
import { getDashboardIdentity } from "../modules/identity/service.js";
import { revokeSession } from "../modules/sessions/service.js";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string };
  const code = e.statusCode ?? 500;
  return reply.code(code).send({
    error: code === 500 ? "server_error" : "invalid_request",
    message: e.message ?? "Unexpected error",
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const body = z
      .object({
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.string().email().optional(),
        phone: z.string().min(7).max(32).optional(),
      })
      .parse(req.body);
    try {
      const result = await registerIdentity({ ...body, ...clientMeta(req) });
      return result;
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
        response: z.any(),
      })
      .parse(req.body);
    try {
      const result = await verifyRegistration({
        userId: body.userId,
        response: body.response,
        deviceName: body.deviceName,
        ...clientMeta(req),
      });
      if (!result.sessionToken) {
        throw Object.assign(new Error("Session was not created"), { statusCode: 500 });
      }
      setSessionCookie(reply, result.sessionToken);
      return {
        trustId: result.trustId,
        profile: result.profile,
        device: result.device,
        sessionId: result.sessionId,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/webauthn/login/options", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email().optional(),
        phone: z.string().optional(),
      })
      .parse(req.body ?? {});
    try {
      return await loginOptions(body.email, body.phone);
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
      return {
        trustId: result.trustId,
        profile: result.profile,
        device: result.device,
        sessionId: result.sessionId,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  app.post("/auth/session", { preHandler: requireSession }, async (req) => {
    const identity = await getDashboardIdentity(req.auth!.userId);
    return { authenticated: true, identity, sessionId: req.auth!.sessionId };
  });

  app.post("/auth/logout", { preHandler: requireSession }, async (req, reply) => {
    await revokeSession(req.auth!.sessionId!, req.auth!.userId, clientMeta(req));
    clearSessionCookie(reply);
    return { ok: true };
  });
}
