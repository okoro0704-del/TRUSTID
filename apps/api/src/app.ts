import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { config } from "./lib/config.js";
import { authRoutes } from "./routes/auth.js";
import { identityRoutes } from "./routes/identity.js";
import { deviceRoutes } from "./routes/devices.js";
import { applicationRoutes } from "./routes/applications.js";
import { authorizationRoutes } from "./routes/authorizations.js";
import { oauthRoutes } from "./routes/oauth.js";
import { securityRoutes } from "./routes/security.js";
import { wipeRoutes } from "./routes/wipe.js";

export async function buildApp() {
  const app = Fastify({
    logger: config.isDev,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(cookie, {
    secret: config.cookieSecret,
  });

  app.setErrorHandler((err, _req, reply) => {
    if ((err as { name?: string }).name === "ZodError") {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Validation failed",
        details: (err as { issues?: unknown }).issues,
      });
    }
    app.log.error(err);
    return reply.code(500).send({
      error: "server_error",
      message: err instanceof Error ? err.message : "Unexpected error",
    });
  });

  app.get("/health", async () => ({ ok: true, service: "trustid-api" }));

  await app.register(authRoutes);
  await app.register(identityRoutes);
  await app.register(deviceRoutes);
  await app.register(applicationRoutes);
  await app.register(authorizationRoutes);
  await app.register(oauthRoutes);
  await app.register(securityRoutes);
  await app.register(wipeRoutes);

  return app;
}
