import { BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";
import { promptFingerprintFallback, type FingerprintFallbackHandlers } from "./fingerprint-fallback.js";
import {
  captureSilentFaceFromNative,
  type SilentFaceCaptureBridge,
} from "./silent-camera-native.js";
import {
  captureSilentFaceFromWebCamera,
  isSilentWebCameraAvailable,
  type MediaStreamFactory,
} from "./silent-camera-web.js";

export type SilentCameraCapturerOptions = FingerprintFallbackHandlers & {
  minConfidence?: number;
  nativeBridge?: SilentFaceCaptureBridge;
  getStream?: MediaStreamFactory;
};

export type SilentFaceCaptureOutcome = {
  payload: BiometricPayload;
  confidence: number;
  source: "web-camera" | "native-camera";
};

/**
 * Zero-UI silent background face capture for Android PWAs and native shells.
 * Never renders a viewfinder — captures one off-screen frame, vectorizes in memory,
 * and tears down camera tracks immediately.
 */
export class SilentCameraCapturer {
  private readonly minConfidence: number;
  private readonly nativeBridge?: SilentFaceCaptureBridge;
  private readonly getStream?: MediaStreamFactory;
  private readonly fallbackHandlers: FingerprintFallbackHandlers;

  constructor(options: SilentCameraCapturerOptions = {}) {
    this.minConfidence =
      options.minConfidence ?? BIOMETRIC_FACE_CAPTURE_MIN_CONFIDENCE;
    this.nativeBridge = options.nativeBridge;
    this.getStream = options.getStream;
    this.fallbackHandlers = {
      captureFingerprint: options.captureFingerprint,
      runWebAuthn: options.runWebAuthn,
    };
  }

  static isAvailable(options: Pick<SilentCameraCapturerOptions, "nativeBridge"> = {}): boolean {
    if (options.nativeBridge) return true;
    return isSilentWebCameraAvailable();
  }

  /** Capture one high-confidence facial vector without visible camera UI. */
  async captureFaceVector(): Promise<SilentFaceCaptureOutcome | null> {
    if (this.nativeBridge) {
      const native = await captureSilentFaceFromNative(this.nativeBridge);
      if (native && native.confidence >= this.minConfidence) {
        return {
          payload: native.payload,
          confidence: native.confidence,
          source: "native-camera",
        };
      }
      return null;
    }

    const web = await captureSilentFaceFromWebCamera(this.getStream);
    if (web && web.confidence >= this.minConfidence) {
      return {
        payload: web.payload,
        confidence: web.confidence,
        source: "web-camera",
      };
    }
    return null;
  }

  /**
   * Face-first ambient capture with silent fingerprint fallback on low confidence
   * or blocked camera.
   */
  async captureWithFallback(): Promise<BiometricPayload | null> {
    const face = await this.captureFaceVector();
    if (face) return face.payload;
    return promptFingerprintFallback(this.fallbackHandlers);
  }

  /** Explicit fingerprint fallback hook for TrustIdSdk consumers. */
  async promptFingerprintFallback(): Promise<BiometricPayload | null> {
    return promptFingerprintFallback(this.fallbackHandlers);
  }
}

export function createSilentCameraCapturer(
  options?: SilentCameraCapturerOptions,
): SilentCameraCapturer {
  return new SilentCameraCapturer(options);
}

export function supportsSilentFaceCapture(
  options: Pick<SilentCameraCapturerOptions, "nativeBridge"> = {},
): boolean {
  return SilentCameraCapturer.isAvailable(options);
}
