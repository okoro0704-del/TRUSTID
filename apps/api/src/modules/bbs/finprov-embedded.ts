import type {
  BaasResult,
  FinProvInitiateInput,
  FinProvStepUpChallenge,
  FinProvVerifyInput,
  IFinProvClient,
} from "@trustid/baas-sdk";
import { config } from "../../lib/config.js";
import { setFinProvClient } from "../baas/registry.js";
import {
  BbsError,
  confirmBbsStepUp,
  getBbsChallengeStatus,
  initiateBbsStepUp,
  verifyBbsStepUpProof,
} from "./service.js";
import type { BbsInitiateInput, BbsVerifyInput } from "./schemas.js";

export type EmbeddedInitiateContext = FinProvInitiateInput & {
  userId: string;
  applicationId?: string;
  scopes: string[];
  deviceId?: string | null;
  ip?: string;
  userAgent?: string;
  body?: BbsInitiateInput;
};

/**
 * Temporary embedded FinProv provider.
 * Payment step-up state still lives in TrustID DB until a remote FinProv deploys.
 * All `/bbs/*` routes must go through getFinProvClient() — not Prisma directly.
 */
export class EmbeddedFinProvClient implements IFinProvClient {
  readonly bound = true;
  readonly mode = "embedded" as const;
  readonly baseUrl = null;

  async initiateStepUp(
    input: FinProvInitiateInput | EmbeddedInitiateContext,
  ): Promise<BaasResult<FinProvStepUpChallenge>> {
    try {
      const ctx = input as EmbeddedInitiateContext;
      if (!ctx.userId || !ctx.scopes) {
        return {
          ok: false,
          error: "embedded_finprov_requires_auth_context",
          via: "finprov",
        };
      }
      const challenge = await initiateBbsStepUp({
        userId: ctx.userId,
        applicationId: ctx.applicationId,
        scopes: ctx.scopes,
        deviceId: ctx.deviceId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        body: ctx.body ?? {
          paymentHash: ctx.paymentHash,
          amountMinor: ctx.amountMinor,
          currency: ctx.currency,
          merchantRef: ctx.merchantRef,
          audience: ctx.audience,
          requireOob: ctx.requireOob,
          reference: ctx.reference,
          intentId: ctx.intentId,
        },
      });
      return { ok: true, data: challenge as FinProvStepUpChallenge, via: "finprov" };
    } catch (err) {
      return mapErr(err);
    }
  }

  async confirmStepUp(
    challengeId: string,
    _accessToken: string,
    body?: Record<string, unknown>,
  ): Promise<BaasResult<FinProvStepUpChallenge>> {
    try {
      const userId = typeof body?.userId === "string" ? body.userId : undefined;
      if (!userId) {
        return { ok: false, error: "embedded_finprov_requires_user", via: "finprov" };
      }
      const challenge = await confirmBbsStepUp({
        userId,
        challengeId,
        deviceId:
          typeof body?.deviceId === "string" || body?.deviceId === null
            ? (body.deviceId as string | null)
            : undefined,
      });
      return { ok: true, data: challenge as FinProvStepUpChallenge, via: "finprov" };
    } catch (err) {
      return mapErr(err);
    }
  }

  async verifyStepUp(
    input: FinProvVerifyInput,
  ): Promise<BaasResult<{ valid: boolean; status: string; reason?: string }>> {
    try {
      const result = await verifyBbsStepUpProof(input as BbsVerifyInput);
      return { ok: true, data: result, via: "finprov" };
    } catch (err) {
      return mapErr(err);
    }
  }

  async getChallengeStatus(
    challengeId: string,
    _accessToken?: string,
    userId?: string,
  ): Promise<BaasResult<FinProvStepUpChallenge>> {
    try {
      const challenge = await getBbsChallengeStatus(challengeId, userId);
      return { ok: true, data: challenge as FinProvStepUpChallenge, via: "finprov" };
    } catch (err) {
      return mapErr(err);
    }
  }
}

function mapErr(err: unknown): BaasResult<never> {
  if (err instanceof BbsError) {
    return {
      ok: false,
      error: err.message,
      statusCode: err.statusCode,
      via: "finprov",
    };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : "finprov_embedded_error",
    via: "finprov",
  };
}

export function registerEmbeddedFinProvIfNeeded() {
  if (config.finprov.mode === "embedded") {
    setFinProvClient(new EmbeddedFinProvClient());
  }
}
