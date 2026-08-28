import type { BiometricGate } from "@trustid/device-security";
import type { BiometricAuthResult, NativeDakBridge } from "../types.js";
import { exportAes256Key, generateAes256Key, hkdfSha256, importAes256Key } from "./aes-gcm.js";

const DAK_SALT = new TextEncoder().encode("trustid-sovereign-dak-v1");
const CDK_SALT = new TextEncoder().encode("trustid-sovereign-cdk-v1");

/**
 * Device Attestation Root Key session.
 * - Native: DAK never leaves Keystore/Keychain; CDK derived in secure module.
 * - Web/PWA: software DAK gated by BiometricGate (WebAuthn UV); CDK via HKDF in memory only.
 */
export class DakSession {
  private dakMaterial: Uint8Array | null = null;
  private nativeHandle: string | null = null;
  private unlocked = false;

  constructor(
    private readonly gate: BiometricGate,
    private readonly native?: NativeDakBridge,
  ) {}

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  async unlock(reason = "Unlock Sovereign Vault"): Promise<BiometricAuthResult> {
    if (this.native) {
      const avail = await this.gate.getAvailability();
      const result = await this.native.unlockDakAfterBiometric({
        reason,
        strongOnly: true,
        allowDeviceCredential: false,
      });
      this.nativeHandle = result.sessionHandle;
      this.unlocked = true;
      return {
        ok: true,
        method: avail.hardwareBoundKeys ? "secure_hardware" : "native_biometric",
        duress: result.duress,
      };
    }

    const auth = await this.gate.authenticate({
      reason,
      allowDeviceCredential: false,
      strongOnly: true,
    });
    if (!this.dakMaterial) {
      const dakKey = await generateAes256Key(true);
      this.dakMaterial = await exportAes256Key(dakKey);
    }
    this.unlocked = true;
    return { ok: auth.ok, method: auth.method, duress: false };
  }

  async deriveCdk(assetId: string, chunkIndex: number): Promise<CryptoKey> {
    if (!this.unlocked) {
      throw new Error("DAK session locked  biometric step-up required");
    }

    if (this.native && this.nativeHandle) {
      const { cdkBase64 } = await this.native.deriveCdk({
        sessionHandle: this.nativeHandle,
        assetId,
        chunkIndex,
      });
      const raw = Uint8Array.from(atob(cdkBase64), (c) => c.charCodeAt(0));
      return importAes256Key(raw);
    }

    if (!this.dakMaterial) {
      throw new Error("DAK material unavailable");
    }
    const info = `cdk:${assetId}:${chunkIndex}`;
    const cdkRaw = await hkdfSha256(this.dakMaterial, info, CDK_SALT, 32);
    return importAes256Key(cdkRaw);
  }

  lock(): void {
    if (this.dakMaterial) this.dakMaterial.fill(0);
    this.dakMaterial = null;
    this.nativeHandle = null;
    this.unlocked = false;
    void this.native?.lockDak();
  }
}

/** Persist wrapped DAK for web fallback (encrypted with gate-derived wrapping key). */
export async function wrapDakForStorage(dakMaterial: Uint8Array, wrappingKey: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(dakMaterial.byteLength);
  plain.set(dakMaterial);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    plain.buffer,
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return combined.buffer;
}

export async function unwrapDakFromStorage(
  wrapped: ArrayBuffer,
  wrappingKey: CryptoKey,
): Promise<Uint8Array> {
  const buf = new Uint8Array(wrapped);
  const iv = buf.subarray(0, 12);
  const cipher = buf.subarray(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrappingKey, cipher);
  return new Uint8Array(plain);
}

export { DAK_SALT, CDK_SALT };
