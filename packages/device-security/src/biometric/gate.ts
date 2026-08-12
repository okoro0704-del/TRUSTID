import type { BiometricAvailability, BiometricGateConfig, SecurityPlatform } from "../types.js";

export interface BiometricGate {
  getAvailability(): Promise<BiometricAvailability>;
  /**
   * Present the OS biometric challenge.
   * On native, unlocks Keystore CryptoObject / Keychain access control.
   * Throws if cancelled or if weak credentials are required but disallowed.
   */
  authenticate(config: BiometricGateConfig): Promise<{ ok: true; method: string }>;
}

export function detectPlatform(): SecurityPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Win|Mac|Linux/i.test(ua) && !/Mobile/i.test(ua)) return "desktop";
  return "web";
}

/** Browser / PWA adapter � UV via caller-supplied WebAuthn step-up. */
export class WebBiometricGate implements BiometricGate {
  constructor(
    private readonly runWebAuthnUv: () => Promise<unknown>,
  ) {}

  async getAvailability(): Promise<BiometricAvailability> {
    const platform = detectPlatform();
    const publicKey = typeof window !== "undefined" && !!window.PublicKeyCredential;
    return {
      platform,
      available: publicKey,
      enrolled: publicKey,
      strength: publicKey ? "strong" : "none",
      hardwareBoundKeys: false,
      appLockSupported: false,
      secureWipeSupported: false,
      notes: [
        "PWA uses TrustID WebAuthn user-verification as the biometric gate.",
        "Hardware Keystore DEK binding, gallery wipe, and cross-app lock require the TrustID Device app.",
      ],
    };
  }

  async authenticate(config: BiometricGateConfig): Promise<{ ok: true; method: string }> {
    if (config.allowDeviceCredential === true) {
      // WebAuthn UV may still use device PIN depending on authenticator; we do not add a TrustID PIN.
    }
    await this.runWebAuthnUv();
    return { ok: true, method: "webauthn_uv" };
  }
}

type NativeBridge = {
  getAvailability(): Promise<BiometricAvailability>;
  authenticate(options: {
    reason: string;
    allowDeviceCredential: boolean;
    strongOnly: boolean;
  }): Promise<{ ok: boolean; method: string }>;
};

/** Capacitor / native plugin bridge. */
export class NativeBiometricGate implements BiometricGate {
  constructor(private readonly bridge: NativeBridge) {}

  getAvailability(): Promise<BiometricAvailability> {
    return this.bridge.getAvailability();
  }

  async authenticate(
    config: BiometricGateConfig,
  ): Promise<{ ok: true; method: string }> {
    const result = await this.bridge.authenticate({
      reason: config.reason,
      allowDeviceCredential: config.allowDeviceCredential === true,
      strongOnly: config.strongOnly !== false,
    });
    if (!result.ok) throw new Error("Biometric authentication failed");
    return { ok: true, method: result.method };
  }
}
