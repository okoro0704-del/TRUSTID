import { BIOMETRIC_MODALITIES, type BiometricModality } from "@trustid/shared";

export type DevicePlatform = "ios" | "android" | "desktop" | "kiosk" | "unknown";

export type DeviceBiometricContext = {
  platform: DevicePlatform;
  /** Primary sensor for daily single-biometric sign-in */
  primaryModality: BiometricModality;
  supportsFace: boolean;
  supportsFingerprint: boolean;
  /** Silent off-screen face capture (Android PWA / native) */
  supportsSilentFace: boolean;
  /** ATM / kiosk — accept first successful capture from either sensor */
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
 * iOS ? Face, Android/PWA ? silent background face (fingerprint fallback), Kiosk ? either.
 */
export function detectDeviceBiometricContext(
  userAgent: string = readUa(),
  options: { silentFaceAvailable?: boolean } = {},
): DeviceBiometricContext {
  const silentFace = options.silentFaceAvailable ?? false;
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
      supportsSilentFace: silentFace,
      multiSensor: true,
    };
  }

  if (isIosLike(ua)) {
    return {
      platform: "ios",
      primaryModality: BIOMETRIC_MODALITIES.FACE,
      supportsFace: true,
      supportsFingerprint: false,
      supportsSilentFace: silentFace,
      multiSensor: false,
    };
  }

  if (/Android/i.test(ua)) {
    return {
      platform: "android",
      primaryModality: BIOMETRIC_MODALITIES.FACE,
      supportsFace: true,
      supportsFingerprint: true,
      supportsSilentFace: true,
      multiSensor: false,
    };
  }

  // Desktop / POS Chrome — silent face when camera available, else fingerprint
  if (/Chrome|Edg|Firefox|Safari/i.test(ua)) {
    const facePrimary = silentFace;
    return {
      platform: "desktop",
      primaryModality: facePrimary
        ? BIOMETRIC_MODALITIES.FACE
        : BIOMETRIC_MODALITIES.FINGERPRINT,
      supportsFace: facePrimary,
      supportsFingerprint: true,
      supportsSilentFace: silentFace,
      multiSensor: false,
    };
  }

  return {
    platform: "unknown",
    primaryModality: BIOMETRIC_MODALITIES.FINGERPRINT,
    supportsFace: true,
    supportsFingerprint: true,
    supportsSilentFace: silentFace,
    multiSensor: false,
  };
}
