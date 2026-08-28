import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BiometricAvailability, BiometricGate } from "@trustid/device-security";
import {
  DakSession,
  EncryptedSovereignFileSystem,
} from "@trustid/vault-sdk";
import { VaultProtectedMediaViewer } from "../src/components/VaultProtectedMediaViewer.js";

class MockGate implements BiometricGate {
  async getAvailability(): Promise<BiometricAvailability> {
    return {
      platform: "web",
      available: true,
      enrolled: true,
      strength: "strong",
      hardwareBoundKeys: false,
      appLockSupported: false,
      secureWipeSupported: false,
      notes: [],
    };
  }
  async authenticate() {
    return { ok: true as const, method: "mock" };
  }
}

describe("VaultProtectedMediaViewer", () => {
  it("requires unlock before rendering decrypted media", async () => {
    const gate = new MockGate();
    const dak = new DakSession(gate);
    const esfs = new EncryptedSovereignFileSystem(dak);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await dak.unlock();
    const manifest = await esfs.encryptAsset({
      assetId: "asset-1",
      mimeType: "video/mp4",
      displayName: "clip.mp4",
      bytes,
    });

    render(
      <VaultProtectedMediaViewer
        esfs={esfs}
        dakSession={dak}
        gate={gate}
        assetId={manifest.assetId}
        manifest={manifest}
      />,
    );

    expect(screen.queryByTestId("vault-video")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock & play/i })).toBeInTheDocument();
  });

  it("streams video after biometric unlock", async () => {
    cleanup();
    const user = userEvent.setup();
    const gate = new MockGate();
    const dak = new DakSession(gate);
    const esfs = new EncryptedSovereignFileSystem(dak);
    const bytes = new Uint8Array(64);
    bytes.fill(0xab);
    await dak.unlock();
    const manifest = await esfs.encryptAsset({
      assetId: "asset-2",
      mimeType: "video/mp4",
      displayName: "demo.mp4",
      bytes,
    });

    render(
      <VaultProtectedMediaViewer
        esfs={esfs}
        dakSession={dak}
        gate={gate}
        assetId={manifest.assetId}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: /unlock & play/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /re-authenticate/i })).toBeInTheDocument();
    });
  });
});
