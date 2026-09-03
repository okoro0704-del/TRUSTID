import {
  BIOMETRIC_MODALITIES,
  captureNativeFingerprintTemplate,
  createSilentCameraCapturer,
  detectDeviceBiometricContext,
  supportsSilentFaceCapture,
  type BiometricPayload,
  type FingerprintTemplateBridge,
  type MultiModalBiometricPayload,
  type SilentFaceCaptureBridge,
} from "@trustid/sdk";

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
  registerPlugin?: (name: string) => unknown;
};

function getCap(): CapacitorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
}

function isNativeCapacitor(): boolean {
  return getCap()?.isNativePlatform?.() === true;
}

function getPlugin<T>(name: string): T | undefined {
  const cap = getCap();
  if (!cap?.isNativePlatform?.()) return undefined;
  if (cap.Plugins?.[name]) return cap.Plugins[name] as T;
  try {
    return cap.registerPlugin?.(name) as T;
  } catch {
    return undefined;
  }
}

function getNativeSilentFaceBridge(): SilentFaceCaptureBridge | undefined {
  return getPlugin<SilentFaceCaptureBridge>("TrustIdSilentFaceCapture");
}

function getFingerprintBridge(): FingerprintTemplateBridge | undefined {
  return getPlugin<FingerprintTemplateBridge>("TrustIdBiometricGate");
}

/** Prompt fingerprint and return a cloud-registry fingerprint payload. */
export async function captureFingerprintBackup(
  reason?: string,
): Promise<BiometricPayload | null> {
  const bridge = getFingerprintBridge();
  if (!bridge?.captureFingerprintTemplate) return null;
  return captureNativeFingerprintTemplate(
    bridge,
    reason ?? "Scan your fingerprint for Trust ID backup",
  );
}

/**
 * Identity-first ambient capture: cloud face first, fingerprint as backup.
 * Does NOT probe device-local passkeys / WebAuthn on boot.
 */
export async function captureWebAmbientSingleModal(
  _apiFetch?: ApiFetch,
): Promise<MultiModalBiometricPayload> {
  const nativeBridge = getNativeSilentFaceBridge();
  const silentFace = Boolean(nativeBridge) || supportsSilentFaceCapture();
  const ctx = detectDeviceBiometricContext(undefined, {
    silentFaceAvailable: silentFace,
  });

  const capturer = createSilentCameraCapturer({
    nativeBridge,
  });

  try {
    let facePayload: BiometricPayload | undefined;
    if (ctx.supportsSilentFace || ctx.platform === "android" || nativeBridge) {
      const face = await capturer.captureFaceVector();
      facePayload = face?.payload;
    } else if (ctx.primaryModality === BIOMETRIC_MODALITIES.FACE || silentFace) {
      const face = await capturer.captureFaceVector();
      facePayload = face?.payload;
    } else {
      const face = await capturer.captureFaceVector();
      facePayload = face?.payload;
    }

    if (facePayload) {
      return { face: facePayload };
    }

    // Face unavailable — fingerprint backup for cloud match / login
    const fingerprint = await captureFingerprintBackup(
      "Face not available — scan fingerprint for Trust ID",
    );
    return fingerprint ? { fingerprint } : {};
  } catch {
    try {
      const fingerprint = await captureFingerprintBackup(
        "Scan fingerprint for Trust ID",
      );
      return fingerprint ? { fingerprint } : {};
    } catch {
      return {};
    }
  }
}

export function createWebAmbientCapture(apiFetch: ApiFetch) {
  return {
    payload: () => captureWebAmbientSingleModal(apiFetch),
    captureFingerprintBackup,
    context: () =>
      detectDeviceBiometricContext(undefined, {
        silentFaceAvailable:
          Boolean(getNativeSilentFaceBridge()) || supportsSilentFaceCapture(),
      }),
  };
}
