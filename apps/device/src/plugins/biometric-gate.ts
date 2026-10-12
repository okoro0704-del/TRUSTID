import { registerPlugin } from "@capacitor/core";
import type { BiometricAvailability } from "@trustid/device-security";

export type BiometricGatePlugin = {
  getAvailability(): Promise<BiometricAvailability>;
  authenticate(options: {
    reason: string;
    allowDeviceCredential: boolean;
    strongOnly: boolean;
  }): Promise<{ ok: boolean; method: string }>;
  /** Class 3 biometric, then sign `payload` with the Master Device key (DER, SPKI base64). */
  signPayload(options: { payload: string; reason?: string }): Promise<{
    ok: boolean;
    method: string;
    signatureBase64: string;
    publicKeyBase64: string;
  }>;
};

export const TrustIdBiometricGate = registerPlugin<BiometricGatePlugin>(
  "TrustIdBiometricGate",
);
