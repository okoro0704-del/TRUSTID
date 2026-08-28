import type { RiskContext, RouteSensitivity, StepUpPolicy } from "../types.js";
import { DEFAULT_STEP_UP_POLICY } from "../types.js";

const SENSITIVITY_RANK: Record<RouteSensitivity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function computeRiskScore(ctx: RiskContext): number {
  let score = 0;
  score += SENSITIVITY_RANK[ctx.routeSensitivity] * 20;
  if (ctx.sessionAgeMs > 5 * 60_000) score += 15;
  if (ctx.sessionAgeMs > 15 * 60_000) score += 25;
  if (ctx.orientationChanged) score += 10;
  if (ctx.unrecognizedDevice) score += 40;
  if (ctx.action === "view_encrypted_video") score += 30;
  if (ctx.action === "unlock_hidden_app") score += 35;
  if (ctx.action === "sensitive_transaction") score += 45;
  if (ctx.action === "route_access") score += 10;
  if (ctx.anomalyScore != null) score += Math.min(30, ctx.anomalyScore);
  return Math.min(100, score);
}

export function evaluateStepUpRequired(
  ctx: RiskContext,
  policy: StepUpPolicy = DEFAULT_STEP_UP_POLICY,
): boolean {
  const score = computeRiskScore(ctx);
  if (score >= policy.riskThreshold) return true;
  if (ctx.sessionAgeMs >= policy.maxSessionAgeMs) return true;
  return (
    SENSITIVITY_RANK[ctx.routeSensitivity] >=
    SENSITIVITY_RANK[policy.minSensitivityForStepUp]
  );
}

export type StepUpTrigger = {
  required: boolean;
  riskScore: number;
  reason: string;
};

export function evaluateStepUpTrigger(
  ctx: RiskContext,
  policy: StepUpPolicy = DEFAULT_STEP_UP_POLICY,
): StepUpTrigger {
  const riskScore = computeRiskScore(ctx);
  const required = evaluateStepUpRequired(ctx, policy);
  let reason = "below_threshold";
  if (ctx.sessionAgeMs >= policy.maxSessionAgeMs) reason = "session_age";
  else if (riskScore >= policy.riskThreshold) reason = "risk_score";
  else if (required) reason = "route_sensitivity";
  return { required, riskScore, reason };
}
