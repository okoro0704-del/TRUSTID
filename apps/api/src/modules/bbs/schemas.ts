import { z } from "zod";
import { groth16ProofSchema } from "../zk/schemas.js";

export const BBS_STEP_UP_STATUS = {
  PENDING: "PENDING",
  OOB_REQUIRED: "OOB_REQUIRED",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
} as const;

export type BbsStepUpStatus =
  (typeof BBS_STEP_UP_STATUS)[keyof typeof BBS_STEP_UP_STATUS];

export const bbsInitiateSchema = z.object({
  paymentHash: z.string().min(16).max(128).optional(),
  amountMinor: z.number().int().nonnegative().optional(),
  currency: z.string().min(3).max(8).optional(),
  merchantRef: z.string().min(1).max(200).optional(),
  reference: z.string().min(1).max(200).optional(),
  intentId: z.string().min(1).max(200).optional(),
  audience: z.string().min(1).max(200).optional(),
  requireOob: z.boolean().optional(),
});

export const bbsConfirmSchema = z.object({
  webauthnVerified: z.boolean().default(true),
});

export const bbsVerifySchema = z.object({
  challengeId: z.string().min(1),
  zkProof: z.object({
    claimType: z.string(),
    proof: groth16ProofSchema,
    publicSignals: z.array(z.string()).min(1),
    nullifier: z.string().optional(),
    audience: z.string().optional(),
    issuedAt: z.string().optional(),
    protocol: z.literal("groth16").optional(),
    disclosed: z.record(z.unknown()).optional(),
  }),
  masterSignature: z.string().min(32),
});

export type BbsInitiateInput = z.infer<typeof bbsInitiateSchema>;
export type BbsVerifyInput = z.infer<typeof bbsVerifySchema>;
