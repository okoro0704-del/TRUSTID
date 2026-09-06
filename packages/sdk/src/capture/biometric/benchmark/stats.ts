/**
 * Statistical helpers for biometric operating-point estimability.
 * Rule: a target FAR is NOT ESTIMABLE unless impostorTrials >= 1 / targetFar
 * (zero-failure rule of thumb). Prefer >= 10 / targetFar for a rough CI.
 */

export type Estimability =
  | { status: "ESTIMABLE"; impostorTrials: number; minRequired: number }
  | {
      status: "NOT_ESTIMABLE_WITH_CURRENT_SAMPLE_SIZE";
      impostorTrials: number;
      minRequired: number;
      reason: string;
    };

export function farEstimability(
  impostorTrials: number,
  targetFar: number,
): Estimability {
  const minRequired = Math.ceil(1 / targetFar);
  if (impostorTrials < minRequired) {
    return {
      status: "NOT_ESTIMABLE_WITH_CURRENT_SAMPLE_SIZE",
      impostorTrials,
      minRequired,
      reason: `Need ? ${minRequired} impostor trials to empirically observe FAR=${targetFar} (have ${impostorTrials}). Do not extrapolate.`,
    };
  }
  return { status: "ESTIMABLE", impostorTrials, minRequired };
}

/**
 * Wilson score interval for a binomial proportion (approximate 95% CI).
 * Documented method; returns null when n=0.
 */
export function wilsonInterval95(
  successes: number,
  n: number,
): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.959963984540054; // ~N(0.975)
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin =
    z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}
