/**
 * Hardware-backed TrustID biometrics via WebAuthn / platform passkeys.
 * Never trusts client-side boolean "localAuthOk" flags.
 */
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { createTrustIdSdk } from "@trustid/sdk";
import { isNativeCapacitorShell } from "./security/nativeBridges";

export type BiometricResult = {
  success: boolean;
  error?: string;
  trustId?: string;
};

function apiBase(): string {
  return import.meta.env.VITE_API_URL ?? "/api";
}

/** Safe availability probe — never throws. */
export async function getBiometricAvailability(): Promise<{
  available: boolean;
  biometryType?: string;
  reason?: string;
}> {
  try {
    const gate = window.TrustIdBiometricGate;
    if (gate?.getAvailability) {
      const avail = await gate.getAvailability();
      return {
        available: Boolean(avail?.available),
        biometryType: avail?.strength,
        reason: avail?.available
          ? undefined
          : avail?.notes?.[0] ?? "Hardware biometrics unavailable",
      };
    }
    // Web / PWA: platform authenticator via WebAuthn
    if (typeof window !== "undefined" && window.PublicKeyCredential) {
      const uvpa =
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();
      return {
        available: Boolean(uvpa),
        biometryType: uvpa ? "platform" : undefined,
        reason: uvpa ? undefined : "No platform authenticator on this browser",
      };
    }
    return { available: false, reason: "WebAuthn not supported" };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "Availability check failed",
    };
  }
}

/**
 * Register a hardware passkey for the signed-in TrustID user.
 * Uses session-bound /devices/register/* (server-verified ES256).
 */
export async function registerBiometricPasskey(input?: {
  trustId?: string;
}): Promise<BiometricResult> {
  try {
    const avail = await getBiometricAvailability();
    if (!avail.available) {
      return {
        success: false,
        error:
          avail.reason ??
          "Biometrics are not available on this device. Use a device with Face ID, fingerprint, or a platform passkey.",
      };
    }

    const base = apiBase();

    const optRes = await fetch(`${base}/devices/register/options`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    if (!optRes.ok) {
      const err = await optRes.json().catch(() => ({}));
      throw new Error(
        (err as { message?: string }).message ??
          `Failed to get registration challenge (${optRes.status})`,
      );
    }

    const raw = (await optRes.json()) as Record<string, unknown> & {
      challengeId?: string;
      purpose?: string;
    };
    const { challengeId: _c, purpose: _p, ...optionsJSON } = raw;
    void _c;
    void _p;

    const credential = await startRegistration({
      optionsJSON: optionsJSON as unknown as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"],
    });

    const verifyRes = await fetch(`${base}/devices/register/verify`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        deviceName: isNativeCapacitorShell()
          ? "TrustID Master Phone"
          : "TrustID Browser",
        response: credential,
      }),
    });
    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({}));
      throw new Error(
        (err as { message?: string }).message ??
          `Passkey registration failed (${verifyRes.status})`,
      );
    }

    const data = (await verifyRes.json().catch(() => ({}))) as {
      trustId?: string;
    };
    return { success: true, trustId: data.trustId ?? input?.trustId };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "AbortError") {
      return { success: false, error: "Passkey setup was cancelled." };
    }
    console.error("[TrustID Biometrics Error]:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Setup canceled or failed",
    };
  }
}

/**
 * Cryptographic unlock for a bound install — WebAuthn assertion required.
 * Replaces the insecure localAuthOk boolean path.
 */
export async function unlockBoundInstallWithPasskey(
  installId: string,
): Promise<BiometricResult & { identity?: unknown; sessionToken?: string }> {
  try {
    const avail = await getBiometricAvailability();
    if (!avail.available) {
      return {
        success: false,
        error:
          avail.reason ??
          "No hardware authenticator available. Sign in with face, or register a passkey on this device.",
      };
    }

    const sdk = createTrustIdSdk({ baseUrl: apiBase() });
    const options = await sdk.installUnlockOptions({ installId });

    const { trustId: _t, challengeId: _c, purpose: _p, ...optionsJSON } =
      options as typeof options & {
        challengeId?: string;
        purpose?: string;
      };
    void _t;
    void _c;
    void _p;

    const assertion = await startAuthentication({
      optionsJSON: optionsJSON as unknown as Parameters<
        typeof startAuthentication
      >[0]["optionsJSON"],
    });

    const unlocked = await sdk.installUnlock({
      installId,
      assertion,
    });

    return {
      success: Boolean(unlocked.matched),
      trustId: unlocked.trustId,
      identity: unlocked.identity,
      sessionToken: unlocked.sessionToken ?? unlocked.token,
      error: unlocked.matched
        ? undefined
        : unlocked.error ?? "Passkey unlock failed",
    };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "AbortError") {
      return { success: false, error: "Passkey unlock was cancelled." };
    }
    const msg = err instanceof Error ? err.message : "Passkey unlock failed";
    console.error("[TrustID Passkey Unlock]:", msg);
    return { success: false, error: msg };
  }
}

/**
 * Crash-safe native fingerprint template capture for cloud backup enroll.
 * Always returns a result object — never throws to the UI.
 */
export async function safeCaptureFingerprintBackup(
  reason?: string,
): Promise<BiometricResult & { payload?: import("@trustid/sdk").BiometricPayload }> {
  try {
    const avail = await getBiometricAvailability();
    if (!avail.available && isNativeCapacitorShell()) {
      return {
        success: false,
        error:
          avail.reason ??
          "Fingerprint hardware is not available. Enable biometrics in device settings.",
      };
    }

    const { captureFingerprintBackup } = await import("./ambientCapture");
    const payload = await captureFingerprintBackup(
      reason ?? "Scan your fingerprint for Trust ID backup",
    );
    if (!payload) {
      return {
        success: false,
        error: "Fingerprint capture cancelled or unavailable on this device.",
      };
    }
    return { success: true, payload };
  } catch (err) {
    console.error("[TrustID Fingerprint Backup]:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Fingerprint setup failed",
    };
  }
}
