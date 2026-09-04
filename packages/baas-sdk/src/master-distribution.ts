import { createHmac } from "node:crypto";
import type { BaasResult } from "./types.js";

function b64url(input: string | Buffer) {
  return Buffer.from(typeof input === "string" ? input : input).toString("base64url");
}

/** Mint HS256 TrustID service JWT for Master Distributor (sub + roles + optional tenantId). */
export function mintMasterDistributionServiceJwt(input: {
  secret: string;
  issuer: string;
  audience: string;
  sub: string;
  tenantId?: string;
  roles?: Array<"admin" | "operator" | "viewer" | "service">;
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
      roles: input.roles ?? ["service"],
      iat: now,
      exp: now + (input.ttlSeconds ?? 3600),
    }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", input.secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export type DistributionProvisionDomainInput = {
  tenantId: string;
  subdomain: string;
  customDomain: string;
  sub?: string;
};

export type DistributionBootstrapTenantInput = {
  tenantId: string;
  subdomain: string;
  customDomain?: string;
  enabledPrimitives: Array<
    "hospitality" | "transport" | "enterprise" | "identity" | "billing" | "messaging"
  >;
  displayName?: string;
  brand?: { primaryColor?: string; logoUrl?: string };
  oauthDestinations?: string[];
  enabledModules?: string[];
  sub?: string;
};

export interface IMasterDistributionClient {
  readonly bound: boolean;
  readonly baseUrl: string | null;
  health(): Promise<BaasResult<{ ok: boolean; service?: string }>>;
  provisionDomain(
    input: DistributionProvisionDomainInput,
  ): Promise<BaasResult<Record<string, unknown>>>;
  domainStatus(
    domainId: string,
    opts?: { sub?: string; tenantId?: string },
  ): Promise<BaasResult<Record<string, unknown>>>;
  bootstrapTenant(
    input: DistributionBootstrapTenantInput,
  ): Promise<BaasResult<Record<string, unknown>>>;
}

export class UnboundMasterDistributionClient implements IMasterDistributionClient {
  readonly bound = false;
  readonly baseUrl = null;
  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    return { ok: false, error: "master_distribution_unbound", via: "unbound" };
  }
  async provisionDomain(): Promise<BaasResult<Record<string, unknown>>> {
    return { ok: false, error: "master_distribution_unbound", via: "unbound" };
  }
  async domainStatus(): Promise<BaasResult<Record<string, unknown>>> {
    return { ok: false, error: "master_distribution_unbound", via: "unbound" };
  }
  async bootstrapTenant(): Promise<BaasResult<Record<string, unknown>>> {
    return { ok: false, error: "master_distribution_unbound", via: "unbound" };
  }
}

/**
 * HTTP consumer for Master Distributor Engine.
 * Domain/tenant provisioning lives here — not inside TrustID.
 */
export class HttpMasterDistributionClient implements IMasterDistributionClient {
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

  private token(opts?: { sub?: string; tenantId?: string }) {
    return mintMasterDistributionServiceJwt({
      secret: this.opts.jwtSecret,
      issuer: this.opts.issuer ?? "lifeos-trust-id",
      audience: this.opts.audience ?? "master-distributor-engine",
      sub: opts?.sub ?? "trustid-service",
      tenantId: opts?.tenantId,
      roles: ["service", "admin"],
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
          error: `Master Distribution health ${res.status}`,
          statusCode: res.status,
          via: "master_distribution",
        };
      }
      const data = (await res.json().catch(() => ({ status: "ok" }))) as {
        status?: string;
        service?: string;
      };
      return {
        ok: true,
        data: { ok: data.status !== "error", service: data.service },
        via: "master_distribution",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Master Distribution unreachable",
        via: "master_distribution",
      };
    }
  }

  async provisionDomain(
    input: DistributionProvisionDomainInput,
  ): Promise<BaasResult<Record<string, unknown>>> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/distributor/domains/provision`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token({
            sub: input.sub,
            tenantId: input.tenantId,
          })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: input.tenantId,
          subdomain: input.subdomain,
          customDomain: input.customDomain,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `provision failed (${res.status})`),
          statusCode: res.status,
          via: "master_distribution",
        };
      }
      return {
        ok: true,
        data: (await res.json()) as Record<string, unknown>,
        via: "master_distribution",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Master Distribution unreachable",
        via: "master_distribution",
      };
    }
  }

  async domainStatus(
    domainId: string,
    opts?: { sub?: string; tenantId?: string },
  ): Promise<BaasResult<Record<string, unknown>>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/distributor/domains/${encodeURIComponent(domainId)}/status`,
        {
          headers: {
            Authorization: `Bearer ${this.token(opts)}`,
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `status failed (${res.status})`),
          statusCode: res.status,
          via: "master_distribution",
        };
      }
      return {
        ok: true,
        data: (await res.json()) as Record<string, unknown>,
        via: "master_distribution",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Master Distribution unreachable",
        via: "master_distribution",
      };
    }
  }

  async bootstrapTenant(
    input: DistributionBootstrapTenantInput,
  ): Promise<BaasResult<Record<string, unknown>>> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/distributor/tenants/bootstrap`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token({
            sub: input.sub,
            tenantId: input.tenantId,
          })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: input.tenantId,
          subdomain: input.subdomain,
          customDomain: input.customDomain,
          enabledPrimitives: input.enabledPrimitives,
          displayName: input.displayName,
          brand: input.brand,
          oauthDestinations: input.oauthDestinations,
          enabledModules: input.enabledModules,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `bootstrap failed (${res.status})`),
          statusCode: res.status,
          via: "master_distribution",
        };
      }
      return {
        ok: true,
        data: (await res.json()) as Record<string, unknown>,
        via: "master_distribution",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Master Distribution unreachable",
        via: "master_distribution",
      };
    }
  }
}
