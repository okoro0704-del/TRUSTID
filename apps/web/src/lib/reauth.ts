import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "../lib/api";

/** Prompt local UV, then return the WebAuthn assertion for sensitive actions. */
export async function reauthenticate(): Promise<unknown> {
  const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/auth/webauthn/reauth/options",
    { method: "POST", body: "{}" },
  );
  return startAuthentication({ optionsJSON: options });
}
