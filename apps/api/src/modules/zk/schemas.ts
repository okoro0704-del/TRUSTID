import { z } from "zod";

export const ZK_CLAIM_TYPES = [
  "compliance_tier",
  "uniqueness",
  "authorization",
  "identity_status",
] as const;

export const zkClaimTypeSchema = z.enum([
  "compliance_tier",
  "uniqueness",
  "authorization",
  "identity_status",
  "trust_tier_gte",
]);

export const groth16ProofSchema = z.object({
  pi_a: z.array(z.string()).min(2),
  pi_b: z.array(z.array(z.string()).min(2)).min(2),
  pi_c: z.array(z.string()).min(2),
  protocol: z.string().optional(),
  curve: z.string().optional(),
  attestation: z.string().optional(),
});

export const zkClaimBundleSchema = z.object({
  claimType: zkClaimTypeSchema,
  proof: groth16ProofSchema,
  publicSignals: z.array(z.string()).min(1),
  nullifier: z.string().optional(),
  disclosed: z
    .object({
      trustTier: z.number().optional(),
      identityStatus: z.string().optional(),
      verified: z.boolean().optional(),
      authorized: z.boolean().optional(),
    })
    .optional(),
  issuedAt: z.string().optional(),
  audience: z.string().optional(),
  protocol: z.literal("groth16").optional(),
});

export const zkProveRequestSchema = z
  .object({
    /** Legacy single-claim selector */
    claim: z.enum(["trust_tier_gte"]).optional(),
    /** LifeOS multi-claim bundle request */
    claimTypes: z.array(z.enum(ZK_CLAIM_TYPES)).optional(),
    minTier: z.number().int().min(0).max(3).default(1),
    audience: z.string().min(1).max(200).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.claimTypes && body.claimTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "claimTypes must be non-empty when provided",
        path: ["claimTypes"],
      });
    }
  });

export type ZkProveRequest = z.infer<typeof zkProveRequestSchema>;

export const zkVerifyRequestSchema = z.union([
  z.object({
    claims: z.array(zkClaimBundleSchema).min(1),
  }),
  zkClaimBundleSchema,
  z.object({
    proof: z.any(),
    publicSignals: z.array(z.string()).min(3),
  }),
]);

export type ZkVerifyRequest = z.infer<typeof zkVerifyRequestSchema>;

export function isBundleProveRequest(body: ZkProveRequest): boolean {
  return Array.isArray(body.claimTypes) && body.claimTypes.length > 0;
}
