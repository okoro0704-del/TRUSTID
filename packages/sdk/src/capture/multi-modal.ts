import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import type { CaptureHandlers, MultiModalBiometricPayload } from "./types.js";

/**
 * Collect available biometric modalities on boot.
 * Priority: passive face recognition, then fingerprint touch sensor.
 */
export async function captureMultiModal(
  handlers: CaptureHandlers = {},
): Promise<MultiModalBiometricPayload> {
  const deviceFingerprint = handlers.getDeviceFingerprint
    ? await handlers.getDeviceFingerprint()
    : undefined;

  let face: BiometricPayload | null = null;
  let fingerprint: BiometricPayload | null = null;

  if (handlers.captureFace) {
    try {
      face = await handlers.captureFace();
    } catch {
      /* face sensor unavailable — fall through */
    }
  }

  if (handlers.captureFingerprint) {
    try {
      fingerprint = await handlers.captureFingerprint();
    } catch {
      /* fingerprint sensor unavailable */
    }
  }

  const payload: MultiModalBiometricPayload = {};
  if (face) {
    payload.face = {
      ...face,
      modality: BIOMETRIC_MODALITIES.FACE,
      deviceFingerprint: face.deviceFingerprint ?? deviceFingerprint,
    };
  }
  if (fingerprint) {
    payload.fingerprint = {
      ...fingerprint,
      modality: BIOMETRIC_MODALITIES.FINGERPRINT,
      deviceFingerprint: fingerprint.deviceFingerprint ?? deviceFingerprint,
    };
  }
  if (deviceFingerprint) payload.deviceFingerprint = deviceFingerprint;

  return payload;
}
