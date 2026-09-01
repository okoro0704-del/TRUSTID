import { BIOMETRIC_MODALITIES } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import {
  detectDeviceBiometricContext,
  type DeviceBiometricContext,
} from "./device-context.js";
import type { CaptureHandlers, MultiModalBiometricPayload } from "./types.js";

function wrapPayload(
  biometric: BiometricPayload,
  modality: typeof BIOMETRIC_MODALITIES.FACE | typeof BIOMETRIC_MODALITIES.FINGERPRINT,
  deviceFingerprint?: string,
): MultiModalBiometricPayload {
  const enriched: BiometricPayload = {
    ...biometric,
    modality,
    deviceFingerprint: biometric.deviceFingerprint ?? deviceFingerprint,
  };
  if (modality === BIOMETRIC_MODALITIES.FACE) {
    return { face: enriched, deviceFingerprint };
  }
  return { fingerprint: enriched, deviceFingerprint };
}

/**
 * Capture exactly ONE biometric for daily sign-in.
 * Kiosk/ATM: first successful face OR fingerprint stream.
 * Otherwise: platform primary sensor only.
 */
export async function captureSingleBiometric(
  handlers: CaptureHandlers = {},
  context?: DeviceBiometricContext,
): Promise<MultiModalBiometricPayload> {
  const ctx = context ?? detectDeviceBiometricContext();
  const deviceFingerprint = handlers.getDeviceFingerprint
    ? await handlers.getDeviceFingerprint()
    : undefined;

  if (ctx.multiSensor) {
    if (handlers.captureFace) {
      try {
        const face = await handlers.captureFace();
        if (face) {
          return wrapPayload(face, BIOMETRIC_MODALITIES.FACE, deviceFingerprint);
        }
      } catch {
        /* try fingerprint */
      }
    }
    if (handlers.captureFingerprint) {
      try {
        const fp = await handlers.captureFingerprint();
        if (fp) {
          return wrapPayload(fp, BIOMETRIC_MODALITIES.FINGERPRINT, deviceFingerprint);
        }
      } catch {
        /* no sensor */
      }
    }
    return deviceFingerprint ? { deviceFingerprint } : {};
  }

  if (ctx.primaryModality === BIOMETRIC_MODALITIES.FACE && handlers.captureFace) {
    try {
      const face = await handlers.captureFace();
      if (face) return wrapPayload(face, BIOMETRIC_MODALITIES.FACE, deviceFingerprint);
    } catch {
      /* unavailable */
    }
  }

  if (
    ctx.primaryModality === BIOMETRIC_MODALITIES.FINGERPRINT &&
    handlers.captureFingerprint
  ) {
    try {
      const fp = await handlers.captureFingerprint();
      if (fp) {
        return wrapPayload(fp, BIOMETRIC_MODALITIES.FINGERPRINT, deviceFingerprint);
      }
    } catch {
      /* unavailable */
    }
  }

  return deviceFingerprint ? { deviceFingerprint } : {};
}
