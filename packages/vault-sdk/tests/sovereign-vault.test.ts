import { describe, expect, it, vi } from "vitest";
import type { BiometricAvailability, BiometricGateConfig } from "@trustid/device-security";
import type { BiometricGate } from "@trustid/device-security";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  AppLockRegistry,
  DakSession,
  DuressHandler,
  EncryptedSovereignFileSystem,
  evaluateStepUpRequired,
  generateAes256Key,
  RouteGuard,
  SovereignVault,
  StepUpController,
  type ElfComEmergencyBridge,
  type EmergencyAlertPayload,
} from "../src/index.js";

class MockBiometricGate implements BiometricGate {
  authCalls = 0;
  failNext = false;

  async getAvailability(): Promise<BiometricAvailability> {
    return {
      platform: "web",
      available: true,
      enrolled: true,
      strength: "strong",
      hardwareBoundKeys: false,
      appLockSupported: false,
      secureWipeSupported: false,
      notes: ["mock"],
    };
  }

  async authenticate(_config: BiometricGateConfig) {
    this.authCalls += 1;
    if (this.failNext) throw new Error("Biometric cancelled");
    return { ok: true as const, method: "mock_uv" };
  }
}

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("Sovereign Vault & Privacy Shield", () => {
  it("a) encrypts video payload with AES-256-GCM and fails decrypt without CDK", async () => {
    const gate = new MockBiometricGate();
    const dak = new DakSession(gate);
    const esfs = new EncryptedSovereignFileSystem(dak);

    const videoBytes = new Uint8Array(512_000);
    videoBytes.fill(0xab);
    videoBytes[0] = 0x00;
    videoBytes[1] = 0x00;
    videoBytes[2] = 0x00;
    videoBytes[3] = 0x1c; // ftyp-ish marker for test realism

    await dak.unlock();
    const manifest = await esfs.encryptAsset({
      assetId: "video-test-1",
      mimeType: "video/mp4",
      displayName: "clip.mp4",
      bytes: videoBytes,
      chunkSize: 64 * 1024,
    });
    expect(manifest.chunkCount).toBeGreaterThan(1);

    dak.lock();
    await expect(esfs.decryptAsset("video-test-1")).rejects.toThrow(/locked/i);

    // Wrong CDK cannot decrypt envelope
    const wrongKey = await generateAes256Key(true);
    const records = (esfs as unknown as { chunks: Map<string, { envelope: Uint8Array }[]> }).chunks.get(
      "video-test-1",
    )!;
    const aad = new TextEncoder().encode("ESFS1:video-test-1:0");
    await expect(aesGcmDecrypt(wrongKey, records[0]!.envelope, aad)).rejects.toThrow();
  });

  it("b) biometric unlock derives CDK and decrypts streamed chunks", async () => {
    const gate = new MockBiometricGate();
    const vault = new SovereignVault({ gate });
    const payload = new TextEncoder().encode("trustid-sovereign-video-chunk-stream");

    await vault.dakSession.unlock();
    await vault.esfs.encryptAsset({
      assetId: "stream-1",
      mimeType: "video/webm",
      displayName: "stream.webm",
      bytes: payload,
      chunkSize: 16,
    });

    const chunks: Uint8Array[] = [];
    await vault.esfs.decryptChunkStream("stream-1", (_i, plain) => {
      chunks.push(plain);
    });
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    expect(new TextDecoder().decode(merged)).toBe("trustid-sovereign-video-chunk-stream");
    expect(gate.authCalls).toBeGreaterThan(0);
  });

  it("c) app-lock route guard blocks until biometric re-auth passes", async () => {
    const gate = new MockBiometricGate();
    const storage = new MemoryStorage();
    const registry = new AppLockRegistry(storage);
    await registry.save({
      ...(await registry.load()),
      enabled: true,
      protectedRoutes: [{ path: "/vault/hidden", sensitivity: "critical", hidden: true }],
    });

    const dak = new DakSession(gate);
    const stepUp = new StepUpController(gate, dak, {
      maxSessionAgeMs: 60_000,
      riskThreshold: 10,
      minSensitivityForStepUp: "medium",
    });
    const guard = new RouteGuard(registry, gate, dak, stepUp, () => registry.load());

    await expect(guard.assertRouteAccess("/vault/hidden")).resolves.toBeUndefined();
    expect(gate.authCalls).toBeGreaterThanOrEqual(1);

    gate.failNext = true;
    guard.grantGrace(0);
    await expect(guard.assertRouteAccess("/vault/hidden")).rejects.toThrow(/denied|cancelled/i);
  });

  it("d) duress assertion locks vault and dispatches emergency payload", async () => {
    const gate = new MockBiometricGate();
    const dak = new DakSession(gate);
    await dak.unlock();
    expect(dak.isUnlocked).toBe(true);

    const alerts: EmergencyAlertPayload[] = [];
    const elfcom: ElfComEmergencyBridge = {
      dispatchEmergencyAlert: vi.fn(async (payload) => {
        alerts.push(payload);
        return { ok: true };
      }),
    };

    const registry = new AppLockRegistry();
    const duress = new DuressHandler(dak, registry, elfcom);
    const config = await registry.load();

    const result = await duress.handleDuress({ correlationId: "duress-test-1", config });
    expect(result.decoyMode).toBe(true);
    expect(result.alertDispatched).toBe(true);
    expect(dak.isUnlocked).toBe(false);
    expect(alerts[0]?.type).toBe("vault_duress");
    expect(duress.getState().decoyMode).toBe(true);
  });

  it("policy engine triggers step-up for encrypted video viewing", () => {
    expect(
      evaluateStepUpRequired(
        {
          sessionAgeMs: 1_000,
          routeSensitivity: "low",
          action: "view_encrypted_video",
        },
        { maxSessionAgeMs: 60_000, riskThreshold: 25, minSensitivityForStepUp: "critical" },
      ),
    ).toBe(true);
  });
});
