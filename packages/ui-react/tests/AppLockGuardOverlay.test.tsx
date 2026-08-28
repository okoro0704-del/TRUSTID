import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BiometricAvailability, BiometricGate } from "@trustid/device-security";
import {
  AppLockRegistry,
  DakSession,
  DEFAULT_APP_LOCK_CONFIG,
  RouteGuard,
  StepUpController,
} from "@trustid/vault-sdk";
import { AppLockGuardOverlay } from "../src/components/AppLockGuardOverlay.js";

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

class MockGate implements BiometricGate {
  calls = 0;
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
    this.calls += 1;
    return { ok: true as const, method: "mock" };
  }
}

describe("AppLockGuardOverlay", () => {
  it("blocks protected route until biometric re-auth", async () => {
    const user = userEvent.setup();
    const storage = new MemoryStorage();
    const registry = new AppLockRegistry(storage);
    const config = {
      ...DEFAULT_APP_LOCK_CONFIG,
      enabled: true,
      protectedRoutes: [{ path: "/secret", sensitivity: "high" as const }],
    };
    await registry.save(config);

    const gate = new MockGate();
    const dak = new DakSession(gate);
    const stepUp = new StepUpController(gate, dak, {
      maxSessionAgeMs: 60_000,
      riskThreshold: 100,
      minSensitivityForStepUp: "medium",
    });
    const routeGuard = new RouteGuard(
      registry,
      gate,
      dak,
      stepUp,
      () => registry.load(),
    );

    render(
      <AppLockGuardOverlay path="/secret/page" routeGuard={routeGuard}>
        <div data-testid="protected-content">Secret</div>
      </AppLockGuardOverlay>,
    );

    expect(screen.getByRole("dialog", { name: /app lock gate/i })).toBeInTheDocument();
    expect(screen.getByTestId("protected-content").parentElement).toHaveClass("tid-applock-decoy");

    await user.click(screen.getByTestId("applock-retry"));

    await waitFor(() => {
      expect(screen.getByTestId("protected-content")).toBeVisible();
    });
    expect(gate.calls).toBeGreaterThan(0);
  });
});
