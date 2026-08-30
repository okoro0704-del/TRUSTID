import { registerPlugin } from "@capacitor/core";
import type { SilentAuthBridge, SilentDeviceMeta } from "@trustid/device-security";

export type SilentAuthPlugin = {
  getDeviceMeta(): Promise<SilentDeviceMeta>;
  ensureHardwareKey(): Promise<{
    keyId: string;
    publicKeySpki: string;
    algorithm: string;
  }>;
  signChallenge(options: {
    challenge: string;
    reason?: string;
  }): Promise<{ keyId: string; signature: string }>;
};

export const TrustIdSilentAuth = registerPlugin<SilentAuthPlugin>(
  "TrustIdSilentAuth",
);

/** Adapter that satisfies @trustid/device-security SilentAuthBridge. */
export const silentAuthBridge: SilentAuthBridge = {
  getDeviceMeta: () => TrustIdSilentAuth.getDeviceMeta(),
  ensureHardwareKey: () => TrustIdSilentAuth.ensureHardwareKey(),
  signChallenge: (input) => TrustIdSilentAuth.signChallenge(input),
};
