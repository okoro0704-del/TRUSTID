import type { BiometricGate } from "@trustid/device-security";
import type { DakSession } from "../crypto/dak.js";
import { StepUpController } from "../policy/step-up.js";
import type { AppLockConfig, RouteSensitivity } from "../types.js";
import { AppLockRegistry } from "./registry.js";

export class RouteGuard {
  private graceUntil = 0;

  constructor(
    private readonly registry: AppLockRegistry,
    private readonly gate: BiometricGate,
    private readonly dakSession: DakSession,
    private readonly stepUp: StepUpController,
    private readonly getConfig: () => Promise<AppLockConfig>,
  ) {}

  grantGrace(ms: number): void {
    this.graceUntil = Date.now() + ms;
  }

  private inGrace(): boolean {
    return Date.now() < this.graceUntil;
  }

  async assertRouteAccess(path: string): Promise<void> {
    const config = await this.getConfig();
    if (!config.enabled) return;

    const route = this.registry.isRouteProtected(config, path);
    if (!route && !config.hiddenAppShortcuts.some((id) => path.includes(id))) {
      return;
    }

    if (this.inGrace()) return;

    const sensitivity: RouteSensitivity = route?.sensitivity ?? "high";
    await this.stepUp.ensureStepUp({
      routeSensitivity: sensitivity,
      action: route?.hidden ? "unlock_hidden_app" : "route_access",
    });

    const auth = await this.gate.authenticate({
      reason: route?.hidden ? "Unlock hidden vault route" : "Unlock protected route",
      allowDeviceCredential: config.allowDeviceCredential,
      strongOnly: config.biometricStrongOnly,
    });
    if (!auth.ok) throw new Error("Route access denied — biometric re-auth required");

    this.stepUp.markAuthenticated();
    this.grantGrace(config.postAuthGraceMs);
  }
}
