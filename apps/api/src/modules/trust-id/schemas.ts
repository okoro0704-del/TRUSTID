import { z } from "zod";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_MODALITIES,
  MASTER_STEP_UP_ACTIONS,
} from "@trustid/shared";

export const biometricModalitySchema = z.enum([
  BIOMETRIC_MODALITIES.FACE,
  BIOMETRIC_MODALITIES.FINGERPRINT,
]);

const vectorSchema = z.array(z.number()).length(BIOMETRIC_AI_EMBEDDING_DIMS);

export const biometricPayloadSchema = z
  .object({
    modality: biometricModalitySchema,
    /** Legacy variable-length embedding (pre-AI pipeline) */
    embedding: z.array(z.number()).min(8).max(2048).optional(),
    /** On-device AI 512-D normalized vector (preferred) */
    vector: vectorSchema.optional(),
    modelName: z.string().max(64).optional(),
    modelVersion: z.number().int().positive().optional(),
    deviceFingerprint: z.string().min(8).max(256).optional(),
    /** Client face-presence / quality score */
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((b) => b.vector || b.embedding, {
    message: "Either vector (512-D) or embedding is required",
  });

export const verifyBiometricRequestSchema = z.object({
  biometric: biometricPayloadSchema,
  requireMasterAccess: z.boolean().optional().default(false),
});

export const enrollBiometricRequestSchema = z.object({
  userId: z.string().min(1),
  biometric: biometricPayloadSchema,
});

export const registerMasterDeviceSchema = z.object({
  deviceFingerprint: z.string().min(8).max(256),
  publicKey: z.string().min(16),
  deviceId: z.string().optional(),
});

export const verifyMasterDeviceSchema = z.object({
  deviceFingerprint: z.string().min(8).max(256),
  signature: z.string().min(16),
  challengeId: z.string().min(1),
});

export const issueMasterChallengeSchema = z.object({
  userId: z.string().min(1),
  action: z.enum([
    MASTER_STEP_UP_ACTIONS.WALLET_TRANSFER,
    MASTER_STEP_UP_ACTIONS.SETTINGS_CHANGE,
    MASTER_STEP_UP_ACTIONS.SECURITY_REVOCATION,
    MASTER_STEP_UP_ACTIONS.DEVICE_PROMOTION,
  ]),
  payload: z.record(z.unknown()).optional(),
  requesterFingerprint: z.string().min(8).max(256).optional(),
});

export const approveMasterChallengeSchema = z.object({
  challengeId: z.string().min(1),
  deviceFingerprint: z.string().min(8).max(256),
  signature: z.string().min(16),
});

export type BiometricPayload = z.infer<typeof biometricPayloadSchema>;
export type VerifyBiometricRequest = z.infer<typeof verifyBiometricRequestSchema>;

export const multiModalPayloadSchema = z.object({
  face: biometricPayloadSchema.optional(),
  fingerprint: biometricPayloadSchema.optional(),
  deviceFingerprint: z.string().min(8).max(256).optional(),
});

export const ambientSignInRequestSchema = multiModalPayloadSchema
  .extend({
    allowAutoEnroll: z.boolean().optional().default(true),
    installId: z.string().min(1).max(80).optional(),
  })
  .refine((b) => b.face || b.fingerprint, {
    message: "At least one biometric modality (face or fingerprint) is required",
  });

export type MultiModalPayload = z.infer<typeof multiModalPayloadSchema>;
export type AmbientSignInRequest = z.infer<typeof ambientSignInRequestSchema>;
