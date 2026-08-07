import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api";

type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

let cached: { options: AuthOptions; at: number } | null = null;
let inflight: Promise<AuthOptions> | null = null;

async function fetchReauthOptions(): Promise<AuthOptions> {
  const raw = await api<AuthOptions & { challengeId?: string; purpose?: string }>(
    "/auth/webauthn/reauth/options",
    { method: "POST", body: "{}" },
  );
  const { challengeId: _c, purpose: _p, ...optionsJSON } = raw;
  void _c;
  void _p;
  return optionsJSON;
}

/** Warm reauth options before a sensitive action (helps Android user-activation). */
export function prefetchReauth(): void {
  if (cached && Date.now() - cached.at < 90_000) return;
  if (inflight) return;
  inflight = fetchReauthOptions()
    .then((options) => {
      cached = { options, at: Date.now() };
      return options;
    })
    .finally(() => {
      inflight = null;
    });
  void inflight.catch(() => undefined);
}

/** Prompt local UV, then return the WebAuthn assertion for sensitive actions. */
export async function reauthenticate(): Promise<unknown> {
  let options: AuthOptions;
  if (cached && Date.now() - cached.at < 90_000) {
    options = cached.options;
    cached = null;
  } else if (inflight) {
    options = await inflight;
    cached = null;
  } else {
    options = await fetchReauthOptions();
  }
  try {
    return await startAuthentication({ optionsJSON: options });
  } catch (err) {
    cached = null;
    throw err;
  }
}
