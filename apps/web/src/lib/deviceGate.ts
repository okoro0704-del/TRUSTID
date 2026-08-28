import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api";
import { getOrCreateInstallId, getLocalOccupancy } from "./deviceInstall";
import { getRememberedAccount } from "./rememberedAccount";

export type DeviceGateResult =
  | { action: "continue"; reason: "local_occupancy" | "remembered" | "server_occupied" | "known_passkey" }
  | { action: "allow_create"; reason: "clear" | "unknown_passkey" | "probe_cancelled" };

/**
 * Decide whether this phone may open Create TrustID.
 * Occupied phones are sent to Continue instead.
 */
export async function gateCreateTrustId(): Promise<DeviceGateResult> {
  if (getLocalOccupancy()?.trustId || getRememberedAccount()?.trustId) {
    return {
      action: "continue",
      reason: getLocalOccupancy()?.trustId ? "local_occupancy" : "remembered",
    };
  }

  const installId = await getOrCreateInstallId();
  try {
    const status = await api<{ occupied: boolean }>("/auth/install-status", {
      method: "POST",
      body: JSON.stringify({ installId }),
    });
    if (status.occupied) {
      return { action: "continue", reason: "server_occupied" };
    }
  } catch {
    /* network — fall through to probe */
  }

  try {
    const options = await api<Record<string, unknown>>("/auth/webauthn/login/options", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const {
      challengeId: _c,
      purpose: _p,
      ...optionsJSON
    } = options as Record<string, unknown> & { challengeId?: string; purpose?: string };
    void _c;
    void _p;
    const response = await startAuthentication({
      optionsJSON: optionsJSON as unknown as Parameters<
        typeof startAuthentication
      >[0]["optionsJSON"],
    });
    try {
      await api("/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify({ response }),
      });
      return { action: "continue", reason: "known_passkey" };
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/unknown credential/i.test(message)) {
        return { action: "allow_create", reason: "unknown_passkey" };
      }
      // Other verify errors — still occupied-ish; prefer Continue
      return { action: "continue", reason: "known_passkey" };
    }
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const message = err instanceof Error ? err.message : "";
    if (
      name === "NotAllowedError" ||
      /not allowed|abort|cancel|timed out|timeout/i.test(message)
    ) {
      return { action: "allow_create", reason: "probe_cancelled" };
    }
    return { action: "allow_create", reason: "clear" };
  }
}
