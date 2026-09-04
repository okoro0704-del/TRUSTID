import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../lib/auth-context.js";
import {
  getMasterDistributionClient,
  getPlatformJobClient,
} from "../modules/baas/registry.js";
import { prisma } from "../db/client.js";

/**
 * Thin IdP facades — TrustID authenticates the caller, then forwards to BaaS.
 * No provisioning/job state is owned by TrustID.
 */
export async function baasRoutes(app: FastifyInstance) {
  app.post(
    "/v1/baas/jobs/dispatch",
    { preHandler: requireSession },
    async (req, reply) => {
      const body = z
        .object({
          jobName: z.string().min(1),
          payload: z.record(z.unknown()).optional(),
          delayMs: z.number().int().nonnegative().optional(),
          deduplicationKey: z.string().min(1).optional(),
        })
        .parse(req.body ?? {});
      const user = await prisma.user.findUnique({
        where: { id: req.auth!.userId },
        select: { trustId: true },
      });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const jobs = getPlatformJobClient();
      if (!jobs.bound) {
        return reply.code(503).send({
          error: "platform_job_unbound",
          message: "Platform Job is not configured on this TrustID deployment",
        });
      }
      const result = await jobs.dispatch({
        tenantId: user.trustId,
        sub: req.auth!.userId,
        jobName: body.jobName,
        payload: body.payload,
        delayMs: body.delayMs,
        deduplicationKey: body.deduplicationKey,
      });
      if (!result.ok) {
        return reply.code(result.statusCode ?? 502).send({
          error: "platform_job_error",
          message: result.error,
        });
      }
      return { ...result.data, via: "platform_job" };
    },
  );

  app.get(
    "/v1/baas/jobs/:jobId/status",
    { preHandler: requireSession },
    async (req, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(req.params);
      const user = await prisma.user.findUnique({
        where: { id: req.auth!.userId },
        select: { trustId: true },
      });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const jobs = getPlatformJobClient();
      if (!jobs.bound) {
        return reply.code(503).send({ error: "platform_job_unbound" });
      }
      const result = await jobs.getStatus(
        params.jobId,
        user.trustId,
        req.auth!.userId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode ?? 502).send({
          error: "platform_job_error",
          message: result.error,
        });
      }
      return { ...result.data, via: "platform_job" };
    },
  );

  app.post(
    "/v1/baas/distributor/tenants/bootstrap",
    { preHandler: requireSession },
    async (req, reply) => {
      const body = z
        .object({
          tenantId: z.string().min(1),
          subdomain: z.string().min(1),
          customDomain: z.string().min(3).optional(),
          enabledPrimitives: z
            .array(
              z.enum([
                "hospitality",
                "transport",
                "enterprise",
                "identity",
                "billing",
                "messaging",
              ]),
            )
            .min(1),
          displayName: z.string().optional(),
        })
        .parse(req.body ?? {});
      const dist = getMasterDistributionClient();
      if (!dist.bound) {
        return reply.code(503).send({
          error: "master_distribution_unbound",
          message:
            "Master Distribution is not configured on this TrustID deployment",
        });
      }
      const result = await dist.bootstrapTenant({
        ...body,
        sub: req.auth!.userId,
      });
      if (!result.ok) {
        return reply.code(result.statusCode ?? 502).send({
          error: "master_distribution_error",
          message: result.error,
        });
      }
      return { ...result.data, via: "master_distribution" };
    },
  );

  app.post(
    "/v1/baas/distributor/domains/provision",
    { preHandler: requireSession },
    async (req, reply) => {
      const body = z
        .object({
          tenantId: z.string().min(1),
          subdomain: z.string().min(1),
          customDomain: z.string().min(3),
        })
        .parse(req.body ?? {});
      const dist = getMasterDistributionClient();
      if (!dist.bound) {
        return reply.code(503).send({ error: "master_distribution_unbound" });
      }
      const result = await dist.provisionDomain({
        ...body,
        sub: req.auth!.userId,
      });
      if (!result.ok) {
        return reply.code(result.statusCode ?? 502).send({
          error: "master_distribution_error",
          message: result.error,
        });
      }
      return { ...result.data, via: "master_distribution" };
    },
  );
}
