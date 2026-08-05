import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { resolveSession } from "../modules/sessions/service.js";
import { resolveAccessToken } from "../modules/authorization/service.js";

export type AuthUser = {
  userId: string;
  sessionId?: string;
  deviceId?: string | null;
  trustId?: string;
  scopes?: string[];
  via: "session" | "bearer";
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthUser;
  }
}

export function clientMeta(req: FastifyRequest) {
  return {
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? undefined,
  };
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  const bearer =
    header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  const custom =
    typeof req.headers["x-trustid-session"] === "string"
      ? req.headers["x-trustid-session"].trim()
      : undefined;
  const token = custom || bearer || req.cookies[config.sessionCookieName];
  if (!token) {
    return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
  }
  const session = await resolveSession(token);
  if (!session) {
    if (!custom && !bearer) reply.clearCookie(config.sessionCookieName, { path: "/" });
    return reply.code(401).send({ error: "unauthorized", message: "Session expired" });
  }
  req.auth = {
    userId: session.userId,
    sessionId: session.id,
    deviceId: session.deviceId,
    trustId: session.user.trustId,
    via: custom || bearer ? "bearer" : "session",
  };
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    const access = await resolveAccessToken(token);
    if (!access) {
      return reply.code(401).send({ error: "invalid_token", message: "Invalid access token" });
    }
    req.auth = {
      userId: access.userId,
      trustId: access.trustId,
      scopes: access.scopes,
      via: "bearer",
    };
    return;
  }
  return requireSession(req, reply);
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(config.sessionCookieName, token, {
    path: "/",
    httpOnly: true,
    // lax is enough when the web app same-origin proxies to this API.
    // none is required only for direct cross-site calls (Netlify → Railway hostname).
    sameSite: config.isDev ? "lax" : "none",
    secure: !config.isDev,
    maxAge: config.sessionTtlHours * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(config.sessionCookieName, {
    path: "/",
    sameSite: config.isDev ? "lax" : "none",
    secure: !config.isDev,
  });
}
