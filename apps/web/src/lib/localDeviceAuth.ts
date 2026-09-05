/**
 * Native fingerprint / device PIN fallback when face scan fails on a
 * returning (already-bound) install. Does not mint a new Trust ID.
 */
export async function promptLocalDeviceCredential(reason?: string): Promise<{
  ok: boolean;
  method?: string;
  error?: string;
}> {
  if (typeof window === "undefined") {
    return { ok: false, error: "Not in a browser context" };
  }

  const gate = window.TrustIdBiometricGate;
  if (!gate?.authenticate) {
    return {
      ok: false,
      error: "Native biometric plugin unavailable. Use a hardware passkey instead.",
    };
  }

  try {
    if (gate.getAvailability) {
      const avail = await gate.getAvailability();
      if (!avail?.available) {
        return {
          ok: false,
          error:
            avail?.notes?.[0] ??
            "Biometrics not enrolled. Enable Face ID / fingerprint in device settings.",
        };
      }
    }

    const result = await gate.authenticate({
      reason:
        reason ??
        "Face ID failed. Verify with Fingerprint or Device PIN",
      allowDeviceCredential: true,
      strongOnly: false,
    });
    return { ok: Boolean(result?.ok), method: result?.method };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Biometric prompt failed",
    };
  }
}
