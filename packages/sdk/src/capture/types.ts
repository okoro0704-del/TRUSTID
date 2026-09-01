import type { BiometricPayload } from "../index.js";

export type MultiModalBiometricPayload = {
  face?: BiometricPayload;
  fingerprint?: BiometricPayload;
  deviceFingerprint?: string;
};

export type CaptureHandlers = {
  /** Passive face / depth-map embedding (priority 1) */
  captureFace?: () => Promise<BiometricPayload | null>;
  /** Fingerprint minutiae or WebAuthn assertion embedding (priority 2) */
  captureFingerprint?: () => Promise<BiometricPayload | null>;
  getDeviceFingerprint?: () => Promise<string | undefined>;
};
