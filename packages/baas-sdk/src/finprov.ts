import type { BaasResult } from "./types.js";

/** Canonical FinProv payment step-up challenge (owned by FinProv, not TrustID). */
export type FinProvStepUpChallenge = {
  challengeId: string;
  correlationId: string;
  expiresAt: string;
  paymentHash: string;
  status: string;
  audience?: string;
  paymentNullifier?: string;
  deviceApprovalRequestId?: string | null;
  oobPollToken?: string | null;
};

export type FinProvInitiateInput = {
  accessToken: string;
  paymentHash?: string;
  amountMinor?: number;
  currency?: string;
  merchantRef?: string;
  audience?: string;
  requireOob?: boolean;
  reference?: string;
  intentId?: string;
};

export type FinProvVerifyInput = {
  challengeId: string;
  zkProof: unknown;
  masterSignature: string;
};

export interface IFinProvClient {
  readonly bound: boolean;
  readonly mode: "http" | "embedded" | "unbound";
  readonly baseUrl: string | null;
  initiateStepUp(input: FinProvInitiateInput): Promise<BaasResult<FinProvStepUpChallenge>>;
  confirmStepUp(
    challengeId: string,
    accessToken: string,
    body?: Record<string, unknown>,
  ): Promise<BaasResult<FinProvStepUpChallenge>>;
  verifyStepUp(input: FinProvVerifyInput): Promise<BaasResult<{ valid: boolean; status: string; reason?: string }>>;
  getChallengeStatus(
    challengeId: string,
    accessToken?: string,
  ): Promise<BaasResult<FinProvStepUpChallenge>>;
}

export class UnboundFinProvClient implements IFinProvClient {
  readonly bound = false;
  readonly mode = "unbound" as const;
  readonly baseUrl = null;

  async initiateStepUp(): Promise<BaasResult<FinProvStepUpChallenge>> {
    return { ok: false, error: "finprov_unbound", via: "unbound" };
  }
  async confirmStepUp(): Promise<BaasResult<FinProvStepUpChallenge>> {
    return { ok: false, error: "finprov_unbound", via: "unbound" };
  }
  async verifyStepUp(): Promise<BaasResult<{ valid: boolean; status: string; reason?: string }>> {
    return { ok: false, error: "finprov_unbound", via: "unbound" };
  }
  async getChallengeStatus(): Promise<BaasResult<FinProvStepUpChallenge>> {
    return { ok: false, error: "finprov_unbound", via: "unbound" };
  }
}

/** Remote FinProv engine — TrustID only forwards identity-scoped step-up traffic. */
export class HttpFinProvClient implements IFinProvClient {
  readonly bound = true;
  readonly mode = "http" as const;

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey?: string;
      timeoutMs?: number;
    },
  ) {}

  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }

  private headers(accessToken?: string) {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) h.Authorization = `Bearer ${accessToken}`;
    if (this.opts.apiKey) h["X-FinProv-Api-Key"] = this.opts.apiKey;
    return h;
  }

  async initiateStepUp(input: FinProvInitiateInput): Promise<BaasResult<FinProvStepUpChallenge>> {
    try {
      const res = await fetch(`${this.baseUrl}/bbs/step-up/initiate`, {
        method: "POST",
        headers: this.headers(input.accessToken),
        body: JSON.stringify({
          paymentHash: input.paymentHash,
          amountMinor: input.amountMinor,
          currency: input.currency,
          merchantRef: input.merchantRef,
          audience: input.audience,
          requireOob: input.requireOob,
          reference: input.reference,
          intentId: input.intentId,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `FinProv initiate failed (${res.status})`),
          statusCode: res.status,
          via: "finprov",
        };
      }
      return { ok: true, data: (await res.json()) as FinProvStepUpChallenge, via: "finprov" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "FinProv unreachable",
        via: "finprov",
      };
    }
  }

  async confirmStepUp(
    challengeId: string,
    accessToken: string,
    body?: Record<string, unknown>,
  ): Promise<BaasResult<FinProvStepUpChallenge>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/bbs/step-up/${encodeURIComponent(challengeId)}/confirm`,
        {
          method: "POST",
          headers: this.headers(accessToken),
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `FinProv confirm failed (${res.status})`),
          statusCode: res.status,
          via: "finprov",
        };
      }
      return { ok: true, data: (await res.json()) as FinProvStepUpChallenge, via: "finprov" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "FinProv unreachable",
        via: "finprov",
      };
    }
  }

  async verifyStepUp(
    input: FinProvVerifyInput,
  ): Promise<BaasResult<{ valid: boolean; status: string; reason?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/bbs/step-up/verify`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `FinProv verify failed (${res.status})`),
          statusCode: res.status,
          via: "finprov",
        };
      }
      return {
        ok: true,
        data: (await res.json()) as { valid: boolean; status: string; reason?: string },
        via: "finprov",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "FinProv unreachable",
        via: "finprov",
      };
    }
  }

  async getChallengeStatus(
    challengeId: string,
    accessToken?: string,
  ): Promise<BaasResult<FinProvStepUpChallenge>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/bbs/step-up/${encodeURIComponent(challengeId)}/status`,
        {
          headers: this.headers(accessToken),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text().catch(() => `FinProv status failed (${res.status})`),
          statusCode: res.status,
          via: "finprov",
        };
      }
      return { ok: true, data: (await res.json()) as FinProvStepUpChallenge, via: "finprov" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "FinProv unreachable",
        via: "finprov",
      };
    }
  }
}
