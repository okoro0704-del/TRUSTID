import { createHmac } from "node:crypto";
import type { BaasResult } from "./types.js";

function b64url(input: string | Buffer) {
  return Buffer.from(typeof input === "string" ? input : input).toString("base64url");
}

/** Mint HS256 TrustID service JWT for Platform Jobs Engine (sub + tenantId). */
export function mintPlatformJobServiceJwt(input: {
  secret: string;
  issuer: string;
  audience: string;
  sub: string;
  tenantId: string;
  ttlSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: input.issuer,
      aud: input.audience,
      sub: input.sub,
      tenantId: input.tenantId,
      iat: now,
      exp: now + (input.ttlSeconds ?? 3600),
    }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", input.secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export type PlatformJobDispatchInput = {
  tenantId: string;
  sub?: string;
  jobName: string;
  payload?: Record<string, unknown>;
  delayMs?: number;
  scheduledAt?: string;
  deduplicationKey?: string;
};

export type PlatformJobDispatchResult = {
  jobId: string;
  status: string;
  deduplicated?: boolean;
};

export type PlatformJobStatus = {
  jobId: string;
  status: string;
  attempts?: number;
  error?: string;
  result?: unknown;
  updatedAt?: string;
};

export interface IPlatformJobClient {
  readonly bound: boolean;
  readonly baseUrl: string | null;
  health(): Promise<BaasResult<{ ok: boolean; service?: string }>>;
  dispatch(input: PlatformJobDispatchInput): Promise<BaasResult<PlatformJobDispatchResult>>;
  getStatus(
    jobId: string,
    tenantId: string,
    sub?: string,
  ): Promise<BaasResult<PlatformJobStatus>>;
  cancel(
    jobId: string,
    tenantId: string,
    sub?: string,
  ): Promise<BaasResult<{ jobId: string; status: string }>>;
}

export class UnboundPlatformJobClient implements IPlatformJobClient {
  readonly bound = false;
  readonly baseUrl = null;
  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    return { ok: false, error: "platform_job_unbound", via: "unbound" };
  }
  async dispatch(): Promise<BaasResult<PlatformJobDispatchResult>> {
    return { ok: false, error: "platform_job_unbound", via: "unbound" };
  }
  async getStatus(): Promise<BaasResult<PlatformJobStatus>> {
    return { ok: false, error: "platform_job_unbound", via: "unbound" };
  }
  async cancel(): Promise<BaasResult<{ jobId: string; status: string }>> {
    return { ok: false, error: "platform_job_unbound", via: "unbound" };
  }
}

/**
 * HTTP consumer for Platform Jobs Engine.
 * TrustID enqueues background work here instead of running workers itself.
 */
export class HttpPlatformJobClient implements IPlatformJobClient {
  readonly bound = true;

  constructor(
    private readonly opts: {
      baseUrl: string;
      jwtSecret: string;
      issuer?: string;
      audience?: string;
      timeoutMs?: number;
    },
  ) {}

  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }

  private token(tenantId: string, sub = "trustid-service") {
    return mintPlatformJobServiceJwt({
      secret: this.opts.jwtSecret,
      issuer: this.opts.issuer ?? "lifeos-trust-id",
      audience: this.opts.audience ?? "platform-jobs-engine",
      sub,
      tenantId,
    });
  }

  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `Platform Job health ${res.status}`,
          statusCode: res.status,
          via: "platform_job",
        };
      }
      const data = (await res.json().catch(() => ({ status: "ok" }))) as {
        status?: string;
        service?: string;
      };
      return {
        ok: true,
        data: { ok: data.status !== "error", service: data.service },
        via: "platform_job",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Platform Job unreachable",
        via: "platform_job",
      };
    }
  }

  async dispatch(
    input: PlatformJobDispatchInput,
  ): Promise<BaasResult<PlatformJobDispatchResult>> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/jobs/dispatch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token(input.tenantId, input.sub)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobName: input.jobName,
          payload: input.payload ?? {},
          delayMs: input.delayMs,
          scheduledAt: input.scheduledAt,
          deduplicationKey: input.deduplicationKey,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `dispatch failed (${res.status})`),
          statusCode: res.status,
          via: "platform_job",
        };
      }
      return {
        ok: true,
        data: (await res.json()) as PlatformJobDispatchResult,
        via: "platform_job",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Platform Job unreachable",
        via: "platform_job",
      };
    }
  }

  async getStatus(
    jobId: string,
    tenantId: string,
    sub?: string,
  ): Promise<BaasResult<PlatformJobStatus>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/status`,
        {
          headers: { Authorization: `Bearer ${this.token(tenantId, sub)}` },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `status failed (${res.status})`),
          statusCode: res.status,
          via: "platform_job",
        };
      }
      return { ok: true, data: (await res.json()) as PlatformJobStatus, via: "platform_job" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Platform Job unreachable",
        via: "platform_job",
      };
    }
  }

  async cancel(
    jobId: string,
    tenantId: string,
    sub?: string,
  ): Promise<BaasResult<{ jobId: string; status: string }>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token(tenantId, sub)}`,
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `cancel failed (${res.status})`),
          statusCode: res.status,
          via: "platform_job",
        };
      }
      return {
        ok: true,
        data: (await res.json()) as { jobId: string; status: string },
        via: "platform_job",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Platform Job unreachable",
        via: "platform_job",
      };
    }
  }
}
