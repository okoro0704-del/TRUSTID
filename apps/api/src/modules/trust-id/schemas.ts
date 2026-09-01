import { z } from "zod";
import { BIOMETRIC_MODALITIES, MASTER_STEP_UP_ACTIONS } from "@trustid/shared";

export const biometricModalitySchema = z.enum([
  BIOMETRIC_MODALITIES.FACE,
  BIOMETRIC_MODALITIES.FINGERPRINT,
]);

export const biometricPayloadSchema = z.object({
  modality: biometricModalitySchema,
  /** Normalized embedding vector from client capture pipeline */
  embedding: z.array(z.number()).min(8).max(2048),
  /** Optional hardware fingerprint of the capturing terminal */
  deviceFingerprint: z.string().min(8).max(256).optional(),
});

export const verifyBiometricRequestSchema = z.object({
  biometric: biometricPayloadSchema,
  /** When true, also evaluate Master Device binding on this terminal */
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
