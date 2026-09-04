import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { config } from "./lib/config.js";
import { bootstrapElfComDispatcher } from "./lib/bootstrap-elfcom.js";
import { bootstrapOAuthApplications } from "./lib/bootstrap-oauth-apps.js";
import { authRoutes } from "./routes/auth.js";
import { identityRoutes } from "./routes/identity.js";
import { deviceRoutes } from "./routes/devices.js";
import { applicationRoutes } from "./routes/applications.js";
import { authorizationRoutes } from "./routes/authorizations.js";
import { oauthRoutes } from "./routes/oauth.js";
import { securityRoutes } from "./routes/security.js";
import { trustRoutes } from "./routes/trust.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { accountRoutes } from "./routes/account.js";
import { wipeRoutes } from "./routes/wipe.js";
import {
  deviceApprovalRoutes,
  reauthRoutes,
} from "./routes/device-approvals.js";
import { zkRoutes } from "./routes/zk.js";
import { deviceSyncRoutes } from "./routes/device-sync.js";
import { recoveryRoutes } from "./routes/recovery.js";
import { bbsRoutes } from "./routes/bbs.js";
import { trustIdRoutes } from "./routes/trust-id.js";
import { baasRoutes } from "./routes/baas.js";
import { registerRealtimeGateway } from "./modules/realtime/index.js";
import {
  getBaasBindings,
  getDigiconomyClient,
  getElfComClient,
  getLidiosClient,
  getMasterDistributionClient,
  getPlatformJobClient,
} from "./modules/baas/registry.js";

export async function buildApp() {
  bootstrapElfComDispatcher();
  await bootstrapOAuthApplications();

  const app = Fastify({
    logger: config.isDev,
    trustProxy: true,
  });

  // Netlify/proxies sometimes forward Content-Type: application/json with an
  // empty body on POST. Treat that as {} instead of failing the request.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const raw =
          typeof body === "string"
            ? body
            : Buffer.isBuffer(body)
              ? body.toString("utf8")
              : "";
        if (!raw.trim()) {
          done(null, {});
          return;
        }
        done(null, JSON.parse(raw));
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Invalid JSON");
        (error as { statusCode?: number }).statusCode = 400;
        done(error, undefined);
      }
    },
  );

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(cookie, {
    secret: config.cookieSecret,
  });

  await app.register(websocket);

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

  app.get("/health", async () => ({
    ok: true,
    service: "trustid-api",
    role: "identity_provider",
    // Non-secret: helps diagnose WebAuthn origin/RP ID misconfig in production
    webauthn: {
      rpID: config.webauthn.rpID,
      origins: config.webauthn.origins,
    },
    baas: getBaasBindings(),
    elfcomRealtimeUrl: getElfComClient().realtimeUrl,
  }));

  app.get("/ecosystem/status", async () => {
    const bindings = getBaasBindings();
    const [lidios, digiconomy, platformJob, masterDistribution] =
      await Promise.all([
        getLidiosClient().health(),
        getDigiconomyClient().health(),
        getPlatformJobClient().health(),
        getMasterDistributionClient().health(),
      ]);
    return {
      ok: true,
      identityProvider: "trustid",
      role: "identity_only",
      corePrimitives: [
        "elfcom",
        "datazone",
        "finprov",
        "platform_job",
        "master_distribution",
      ],
      primitives: bindings,
      probes: {
        platform_job: platformJob.ok
          ? platformJob.data
          : { ok: false, error: platformJob.error },
        master_distribution: masterDistribution.ok
          ? masterDistribution.data
          : { ok: false, error: masterDistribution.error },
        lidios: lidios.ok ? lidios.data : { ok: false, error: lidios.error },
        digiconomy: digiconomy.ok
          ? digiconomy.data
          : { ok: false, error: digiconomy.error },
      },
    };
  });

  await app.register(authRoutes);
  await app.register(identityRoutes);
  await app.register(deviceRoutes);
  await app.register(applicationRoutes);
  await app.register(authorizationRoutes);
  await app.register(oauthRoutes);
  await app.register(securityRoutes);
  await app.register(trustRoutes);
  await app.register(passkeyRoutes);
  await app.register(accountRoutes);
  await app.register(deviceApprovalRoutes);
  await app.register(reauthRoutes);
  await app.register(zkRoutes);
  await app.register(deviceSyncRoutes);
  await app.register(recoveryRoutes);
  await app.register(bbsRoutes);
  await app.register(trustIdRoutes);
  await app.register(baasRoutes);
  await app.register(wipeRoutes);

  await registerRealtimeGateway(app);

  return app;
}
