import type { FaceScanDiagnostics, FaceScanReason } from "@trustid/shared";
import type { BiometricPayload } from "../index.js";

export type MultiModalBiometricPayload = {
  face?: BiometricPayload;
  fingerprint?: BiometricPayload;
  deviceFingerprint?: string;
  /**
   * When capture fails before a usable face vector exists, callers must surface
   * this instead of inventing FACE_NOT_DETECTED / BIOMETRIC_MODEL_UNAVAILABLE.
   */
  captureErrorCode?: string;
  captureErrorMessage?: string;
  /** Precise scan reason behind captureErrorCode (diagnostic). */
  captureReasonCode?: FaceScanReason;
  /** Non-biometric scan summary (counters, dimensions, final state). */
  captureDiagnostics?: FaceScanDiagnostics;
};

export type CaptureHandlers = {
  /** Passive face / depth-map embedding (priority 1) */
  captureFace?: () => Promise<BiometricPayload | null>;
  /** Fingerprint minutiae or WebAuthn assertion embedding (priority 2) */
  captureFingerprint?: () => Promise<BiometricPayload | null>;
  getDeviceFingerprint?: () => Promise<string | undefined>;
};
