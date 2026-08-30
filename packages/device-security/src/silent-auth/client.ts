/**
 * Zero-input silent biometric authentication helpers for Trust ID Device.
 * Native path: Keystore/Keychain sign ? POST /v1/auth/silent-assert.
 * Web path: discoverable WebAuthn via the UI package.
 */

export type SilentDeviceMeta = {
  platform: string;
  model: string;
  osVersion: string;
};

export type SilentChallenge = {
  challengeId: string;
  challenge: string;
  purpose: string;
  expiresAt?: string;
};

export type SilentAssertResult = {
  trustId: string;
  sessionId: string;
  identity?: unknown;
  mode: "native" | "webauthn";
};

export type SilentAuthBridge = {
  getDeviceMeta(): Promise<SilentDeviceMeta>;
  ensureHardwareKey(): Promise<{
    keyId: string;
    publicKeySpki: string;
    algorithm: string;
  }>;
  signChallenge(input: {
    challenge: string;
    reason?: string;
  }): Promise<{ keyId: string; signature: string }>;
};

export type SilentAuthApi = {
  fetch: <T>(path: string, init?: RequestInit) => Promise<T>;
};

/**
 * Complete native silent login with zero text inputs.
 * Throws with code device_unpaired when one-time pairing is required.
 */
export async function runNativeSilentLogin(
  bridge: SilentAuthBridge,
  api: SilentAuthApi,
  opts?: { reason?: string },
): Promise<SilentAssertResult> {
  const device = await bridge.getDeviceMeta();
  const challenge = await api.fetch<SilentChallenge>("/auth/silent/challenge", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const signed = await bridge.signChallenge({
    challenge: challenge.challenge,
    reason: opts?.reason ?? "Sign in to Trust ID",
  });

  try {
    return await api.fetch<SilentAssertResult>("/v1/auth/silent-assert", {
      method: "POST",
      body: JSON.stringify({
        mode: "native",
        keyId: signed.keyId,
        challenge: challenge.challenge,
        signature: signed.signature,
        device,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unpaired|device_unpaired/i.test(msg)) {
      const e = new Error("Device is not paired for silent authentication");
      (e as { code?: string }).code = "device_unpaired";
      throw e;
    }
    throw err;
  }
}

/**
 * One-time pairing after an authenticated session exists.
 * Publishes the hardware public key so future Login clicks stay zero-input.
 */
export async function pairSilentHardwareKey(
  bridge: SilentAuthBridge,
  api: SilentAuthApi,
): Promise<{ paired: true; keyId: string; trustId: string }> {
  const device = await bridge.getDeviceMeta();
  const key = await bridge.ensureHardwareKey();
  return api.fetch("/auth/silent/pair", {
    method: "POST",
    body: JSON.stringify({
      keyId: key.keyId,
      publicKeySpki: key.publicKeySpki,
      algorithm: key.algorithm,
      device,
    }),
  });
}
