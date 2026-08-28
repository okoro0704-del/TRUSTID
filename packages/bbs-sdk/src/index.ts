import type { ZkClaimBundle } from "@trustid/zk";

/** Payment step-up challenge lifecycle status. */
export type StepUpChallengeStatus =
  | "PENDING"
  | "OOB_REQUIRED"
  | "APPROVED"
  | "DENIED"
  | "EXPIRED";

export type StepUpChallenge = {
  challengeId: string;
  correlationId: string;
  expiresAt: string;
  paymentHash: string;
  status: StepUpChallengeStatus;
  audience?: string;
  paymentNullifier?: string;
  deviceApprovalRequestId?: string | null;
  oobPollToken?: string | null;
};

export type BbsStepUpProof = {
  challengeId: string;
  zkProof: ZkClaimBundle;
  masterSignature: string;
};

export type StepUpInitiateContext = {
  accessToken: string;
  paymentHash: string;
  amountMinor?: number;
  currency?: string;
  merchantRef?: string;
  audience?: string;
  /** Force cross-device OOB even below threshold. */
  requireOob?: boolean;
};

export type StepUpVerifyResult = {
  valid: boolean;
  challengeId: string;
  status: StepUpChallengeStatus;
  paymentHash?: string;
  paymentNullifier?: string;
  reason?: string;
};

/**
 * Canonical BBS / FinProv contract for payment-bound identity step-up.
 * TrustID API implements the server side; external engines consume via HTTP client.
 */
export interface IBiometricBankingProvider {
  readonly providerId: string;
  initiateStepUp(ctx: StepUpInitiateContext): Promise<StepUpChallenge>;
  verifyStepUpProof(proof: BbsStepUpProof): Promise<StepUpVerifyResult>;
  getChallengeStatus(challengeId: string, accessToken?: string): Promise<StepUpChallenge>;
}

export type TrustIdBbsClientConfig = {
  trustIdApi: string;
};

export class TrustIdBbsHttpProvider implements IBiometricBankingProvider {
  readonly providerId = "trustid-bbs-http";

  constructor(private readonly config: TrustIdBbsClientConfig) {}

  async initiateStepUp(ctx: StepUpInitiateContext): Promise<StepUpChallenge> {
    const res = await fetch(`${this.config.trustIdApi}/bbs/step-up/initiate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentHash: ctx.paymentHash,
        amountMinor: ctx.amountMinor,
        currency: ctx.currency,
        merchantRef: ctx.merchantRef,
        audience: ctx.audience,
        requireOob: ctx.requireOob,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as StepUpChallenge & {
      message?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.message || data.error || "BBS step-up initiate failed");
    }
    return data;
  }

  async verifyStepUpProof(proof: BbsStepUpProof): Promise<StepUpVerifyResult> {
    const res = await fetch(`${this.config.trustIdApi}/bbs/step-up/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    });
    const data = (await res.json().catch(() => ({}))) as StepUpVerifyResult & {
      message?: string;
    };
    if (!res.ok) {
      return {
        valid: false,
        challengeId: proof.challengeId,
        status: "DENIED",
        reason: data.reason || data.message || "verification_failed",
      };
    }
    return data;
  }

  async getChallengeStatus(
    challengeId: string,
    accessToken?: string,
  ): Promise<StepUpChallenge> {
    const res = await fetch(
      `${this.config.trustIdApi}/bbs/step-up/${encodeURIComponent(challengeId)}/status`,
      {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      },
    );
    const data = (await res.json().catch(() => ({}))) as StepUpChallenge & {
      message?: string;
    };
    if (!res.ok) {
      throw new Error(data.message || "Challenge status unavailable");
    }
    return data;
  }
}
