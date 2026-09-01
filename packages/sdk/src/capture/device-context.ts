import { BIOMETRIC_MODALITIES, type BiometricModality } from "@trustid/shared";

export type DevicePlatform = "ios" | "android" | "desktop" | "kiosk" | "unknown";

export type DeviceBiometricContext = {
  platform: DevicePlatform;
  /** Primary sensor for daily single-biometric sign-in */
  primaryModality: BiometricModality;
  supportsFace: boolean;
  supportsFingerprint: boolean;
  /** ATM / kiosk  accept first successful capture from either sensor */
  multiSensor: boolean;
};

function readUa(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent ?? "";
}

function isIosLike(ua: string): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (typeof navigator !== "undefined") {
    const nav = navigator as Navigator & { maxTouchPoints?: number };
    return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
  }
  return false;
}

/**
 * Context-aware primary biometric for single-modality daily sign-in.
 * iOS ? Face, Android/POS ? Fingerprint, Kiosk ? either (first success).
 */
export function detectDeviceBiometricContext(
  userAgent: string = readUa(),
): DeviceBiometricContext {
  const ua = userAgent;
  const kiosk =
    /TrustID-Kiosk|TrustID-Terminal|ATM|Kiosk/i.test(ua) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { TRUSTID_KIOSK?: boolean }).TRUSTID_KIOSK === true);

  if (kiosk) {
    return {
      platform: "kiosk",
      primaryModality: BIOMETRIC_MODALITIES.FACE,
      supportsFace: true,
      supportsFingerprint: true,
      multiSensor: true,
    };
  }

  if (isIosLike(ua)) {
    return {
      platform: "ios",
      primaryModality: BIOMETRIC_MODALITIES.FACE,
      supportsFace: true,
      supportsFingerprint: false,
      multiSensor: false,
    };
  }

  if (/Android/i.test(ua)) {
    return {
      platform: "android",
      primaryModality: BIOMETRIC_MODALITIES.FINGERPRINT,
      supportsFace: false,
      supportsFingerprint: true,
      multiSensor: false,
    };
  }

  // Desktop / POS Chrome — fingerprint-first (platform authenticator)
  if (/Chrome|Edg|Firefox|Safari/i.test(ua)) {
    return {
      platform: "desktop",
      primaryModality: BIOMETRIC_MODALITIES.FINGERPRINT,
      supportsFace: false,
      supportsFingerprint: true,
      multiSensor: false,
    };
  }

  return {
    platform: "unknown",
    primaryModality: BIOMETRIC_MODALITIES.FINGERPRINT,
    supportsFace: true,
    supportsFingerprint: true,
    multiSensor: false,
  };
}
