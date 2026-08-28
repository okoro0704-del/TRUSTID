import type { BiometricGate } from "@trustid/device-security";
import type { DakSession } from "../crypto/dak.js";
import type { RiskContext, StepUpPolicy } from "../types.js";
import { evaluateStepUpTrigger } from "./engine.js";

export class StepUpController {
  private lastAuthAt = 0;

  constructor(
    private readonly gate: BiometricGate,
    private readonly dakSession: DakSession,
    private policy: StepUpPolicy,
  ) {}

  updatePolicy(policy: StepUpPolicy): void {
    this.policy = policy;
  }

  markAuthenticated(): void {
    this.lastAuthAt = Date.now();
  }

  sessionAgeMs(): number {
    if (!this.lastAuthAt) return Number.MAX_SAFE_INTEGER;
    return Date.now() - this.lastAuthAt;
  }

  async ensureStepUp(ctx: Omit<RiskContext, "sessionAgeMs">): Promise<void> {
    const full: RiskContext = { ...ctx, sessionAgeMs: this.sessionAgeMs() };
    const trigger = evaluateStepUpTrigger(full, this.policy);
    if (!trigger.required && this.dakSession.isUnlocked) return;

    const auth = await this.dakSession.unlock(
      trigger.required ? `Step-up required (${trigger.reason})` : "Unlock Sovereign Vault",
    );
    if (!auth.ok) throw new Error("Biometric step-up failed");
    this.markAuthenticated();
  }
}
