import { registerPlugin } from "@capacitor/core";
import type { BiometricAvailability } from "@trustid/device-security";

export type BiometricGatePlugin = {
  getAvailability(): Promise<BiometricAvailability>;
  authenticate(options: {
    reason: string;
    allowDeviceCredential: boolean;
    strongOnly: boolean;
  }): Promise<{ ok: boolean; method: string }>;
};

export const TrustIdBiometricGate = registerPlugin<BiometricGatePlugin>(
  "TrustIdBiometricGate",
);
