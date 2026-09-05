/**
 * Mobile biometric bridge for TrustID — Class 3 (Strong) hardware only.
 * Wraps TrustIdBiometricGate (Android Keystore CryptoObject / iOS Secure Enclave).
 * Never uses capacitor-native-biometric username/password vaults.
 */
import { isNativeCapacitorShell } from "./security/nativeBridges";

export function isMobileApp(): boolean {
  return isNativeCapacitorShell();
}

export type StrictBiometricResult = {
  ok: boolean;
  method?: string;
  error?: string;
  publicKeyBase64?: string;
};

/**
 * Enforce Class 3 Strong Hardware Biometrics (fingerprint / 3D Face ID).
 * Rejects Class 1–2 2D camera face unlock and device PIN fallback.
 */
export async function authenticateTrustIDBiometricStrict(
  userDid: string,
): Promise<boolean> {
  const result = await verifyTrustIDBiometricStrict(userDid);
  return result.ok;
}

export async function verifyTrustIDBiometricStrict(
  userDid?: string,
): Promise<StrictBiometricResult> {
  try {
    if (!isMobileApp()) {
      return {
        ok: false,
        error:
          "Class 3 hardware biometrics require the TrustID native app. Use a platform passkey on web.",
      };
    }

    const gate = window.TrustIdBiometricGate;
    if (!gate?.getAvailability || !gate?.authenticate) {
      return {
        ok: false,
        error: "Native biometric plugin unavailable",
      };
    }

    const availability = await gate.getAvailability().catch((err: unknown) => {
      console.warn("[TrustID] Hardware check failed gracefully:", err);
      return null;
    });

    if (!availability?.available || availability.strength !== "strong") {
      const reason =
        availability?.notes?.[0] ??
        (availability?.strength === "weak"
          ? "Class 1/2 face unlock rejected. Enroll a fingerprint or Class 3 Face in device Settings."
          : "Class 3 Strong Biometrics not available on this device");
      console.warn("[TrustID]", reason);
      return { ok: false, error: reason };
    }

    const didHint =
      userDid && userDid.length > 0
        ? `DID: ${userDid.slice(0, 16)}…`
        : "TrustID Secure Access";

    const result = await gate.authenticate({
      reason: `TrustID Cryptographic Hardware Verification — ${didHint}`,
      title: "TrustID Secure Access",
      subtitle: didHint,
      description: "Touch the fingerprint sensor or use Class 3 Face ID",
      negativeButtonText: "Cancel",
      maxAttempts: 3,
      useFallback: false,
      allowDeviceCredential: false,
      strongOnly: true,
    });

    return {
      ok: Boolean(result?.ok),
      method: result?.method,
      publicKeyBase64: (result as { publicKeyBase64?: string })?.publicKeyBase64,
      error: result?.ok ? undefined : "Biometric verification failed",
    };
  } catch (err: unknown) {
    console.error(
      "TrustID Biometric Verification Error (Gracefully handled):",
      err,
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Biometric verification failed",
    };
  }
}

/**
 * Crash-safe Class 3 fingerprint / strong-biometric enrollment probe.
 * Confirms hardware availability + CryptoObject auth before Keystore bind.
 */
export async function setupTrustIDFingerprintStrict(
  trustId?: string,
): Promise<StrictBiometricResult> {
  try {
    if (!isMobileApp()) {
      return {
        ok: false,
        error:
          "Fingerprint setup is managed by your OS device settings on web. Use Setup passkey, or open the TrustID Android/iOS app.",
      };
    }

    const gate = window.TrustIdBiometricGate;
    if (!gate) {
      return { ok: false, error: "Native biometric plugin unavailable" };
    }

    const availability = await gate.getAvailability().catch((err: unknown) => {
      console.warn("[TrustID] Hardware check failed gracefully:", err);
      return {
        available: false,
        enrolled: false,
        strength: "none" as const,
        notes: ["Hardware check failed"],
      };
    });

    if (!availability.available || availability.strength !== "strong") {
      return {
        ok: false,
        error:
          availability.notes?.[0] ??
          "No Class 3 fingerprint / Face ID sensor detected, or biometrics not enrolled in OS Settings.",
      };
    }

    if (gate.captureFingerprintTemplate) {
      const captured = await gate
        .captureFingerprintTemplate({
          reason: "Confirm your fingerprint to enroll TrustID",
        })
        .catch((err: unknown) => {
          console.error("[TrustID] Keystore / template capture failed:", err);
          return null;
        });

      if (!captured?.ok) {
        return {
          ok: false,
          error:
            "Fingerprint enrollment canceled or Keystore alias unavailable. Ensure fingerprints are registered in Android/iOS Settings.",
        };
      }

      // Bind enrollment marker in EncryptedSharedPreferences / secure prefs.
      if (gate.storeSecure && trustId) {
        await gate.storeSecure({
          key: `trustid_bio_bound_${trustId}`,
          value: captured.publicKeyBase64 ?? "bound",
        }).catch((err: unknown) => {
          console.error("[TrustID] Keystore saving failed:", err);
        });
      }

      return {
        ok: true,
        method: captured.method,
        publicKeyBase64: captured.publicKeyBase64,
      };
    }

    // Fallback: authenticate-only if capture API missing (older builds).
    const verified = await gate
      .authenticate({
        reason: "Confirm your fingerprint to enroll TrustID",
        allowDeviceCredential: false,
        strongOnly: true,
        useFallback: false,
      })
      .catch(() => null);

    if (!verified?.ok) {
      return {
        ok: false,
        error: "Fingerprint enrollment canceled or failed verification",
      };
    }

    return { ok: true, method: verified.method };
  } catch (error: unknown) {
    console.error("Handled Fingerprint Enrollment Exception:", error);
    return {
      ok: false,
      error:
        "Could not complete fingerprint setup. Please ensure fingerprints are registered in Android/iOS Settings.",
    };
  }
}
