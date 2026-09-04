/**
 * Native fingerprint / device PIN fallback when face scan fails on a
 * returning (already-bound) install. Does not mint a new Trust ID.
 */
export async function promptLocalDeviceCredential(reason?: string): Promise<{
  ok: boolean;
  method?: string;
}> {
  if (typeof window === "undefined") return { ok: false };

  const gate = window.TrustIdBiometricGate;
  if (gate?.authenticate) {
    try {
      const result = await gate.authenticate({
        reason:
          reason ??
          "Face ID failed. Verify with Fingerprint or Device PIN",
        allowDeviceCredential: true,
        strongOnly: false,
      });
      return { ok: Boolean(result?.ok), method: result?.method };
    } catch {
      return { ok: false };
    }
  }

  return { ok: false };
}
