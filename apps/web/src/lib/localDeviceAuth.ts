/**
 * Native Class 3 biometric unlock when face scan fails on a bound install.
 * Never accepts Class 1/2 face unlock or device PIN as TrustID proof.
 */
import { verifyTrustIDBiometricStrict } from "./mobileBridge";

export async function promptLocalDeviceCredential(reason?: string): Promise<{
  ok: boolean;
  method?: string;
  error?: string;
}> {
  if (typeof window === "undefined") {
    return { ok: false, error: "Not in a browser context" };
  }

  try {
    const result = await verifyTrustIDBiometricStrict();
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.error ??
          reason ??
          "Class 3 fingerprint / Face ID required. 2D camera unlock is disabled.",
      };
    }
    return { ok: true, method: result.method ?? "biometric_strong" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Biometric prompt failed",
    };
  }
}
