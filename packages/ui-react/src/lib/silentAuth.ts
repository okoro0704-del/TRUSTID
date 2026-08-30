import {
  base64URLStringToBuffer,
  bufferToBase64URLString,
  startAuthentication,
} from "@simplewebauthn/browser";
import type { AuthOptions } from "../components/TrustIdLoginButton.js";
import type { TrustIdIdentity } from "../types.js";

export type SilentAssertIdentityResult = {
  identity: TrustIdIdentity;
  trustId?: string;
  sessionId?: string;
  mode?: string;
};

function toPublicKeyRequestOptions(
  optionsJSON: AuthOptions,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64URLStringToBuffer(optionsJSON.challenge),
    timeout: optionsJSON.timeout,
    rpId: optionsJSON.rpId,
    userVerification: optionsJSON.userVerification,
    allowCredentials: (optionsJSON.allowCredentials ?? []).map((c) => ({
      id: base64URLStringToBuffer(c.id),
      type: "public-key" as const,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

function assertionFromCredential(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64URLString(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
      authenticatorData: bufferToBase64URLString(response.authenticatorData),
      signature: bufferToBase64URLString(response.signature),
      userHandle: response.userHandle
        ? bufferToBase64URLString(response.userHandle)
        : undefined,
    },
  };
}

/**
 * Instant discoverable-credential assertion.
 * Tries mediation `optional` (auto OS prompt), then `conditional`, then direct get.
 */
export async function runImmediateSilentPasskey(optionsJSON: AuthOptions) {
  const publicKeyJson: AuthOptions = {
    ...optionsJSON,
    allowCredentials: optionsJSON.allowCredentials?.length
      ? optionsJSON.allowCredentials
      : [],
  };
  const publicKey = toPublicKeyRequestOptions(publicKeyJson);

  if (typeof navigator !== "undefined" && navigator.credentials?.get) {
    for (const mediation of ["optional", "conditional"] as const) {
      try {
        const cred = (await navigator.credentials.get({
          publicKey,
          mediation,
        } as CredentialRequestOptions)) as PublicKeyCredential | null;
        if (cred) return assertionFromCredential(cred);
      } catch {
        /* try next mediation / fallback */
      }
    }
  }

  try {
    return await startAuthentication({
      optionsJSON: publicKeyJson,
      useBrowserAutofill: true,
    });
  } catch {
    return startAuthentication({ optionsJSON: publicKeyJson });
  }
}

/** Fetch discoverable login options (zero identity fields). */
export async function fetchSilentLoginOptions(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<AuthOptions> {
  const raw = await apiFetch<AuthOptions & { challengeId?: string; purpose?: string }>(
    "/auth/webauthn/login/options",
    { method: "POST", body: JSON.stringify({}) },
  );
  const { challengeId: _c, purpose: _p, ...optionsJSON } = raw;
  void _c;
  void _p;
  return optionsJSON;
}

/** Post WebAuthn assertion to silent-assert and return session identity. */
export async function postSilentWebAuthnAssert(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
  assertion: unknown,
): Promise<SilentAssertIdentityResult> {
  return apiFetch<SilentAssertIdentityResult>("/v1/auth/silent-assert", {
    method: "POST",
    body: JSON.stringify({
      mode: "webauthn",
      response: assertion,
    }),
  });
}

/**
 * Full zero-input web silent login: options ? biometric ? silent-assert.
 */
export async function executeSilentWebLogin(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<SilentAssertIdentityResult> {
  const options = await fetchSilentLoginOptions(apiFetch);
  const assertion = await runImmediateSilentPasskey(options);
  return postSilentWebAuthnAssert(apiFetch, assertion);
}

/** Session-scoped guard so auto-login only fires once per tab load. */
const ATTEMPTED_KEY = "trustid.silent_auto_login.attempted";

export function hasAttemptedSilentAutoLogin(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return sessionStorage.getItem(ATTEMPTED_KEY) === "1";
}

export function markSilentAutoLoginAttempted(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(ATTEMPTED_KEY, "1");
}

export function clearSilentAutoLoginAttempt(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(ATTEMPTED_KEY);
}

let inflight: Promise<SilentAssertIdentityResult> | null = null;

/** Deduped silent web login (Safe under React StrictMode double-mount). */
export function executeSilentWebLoginOnce(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<SilentAssertIdentityResult> {
  if (inflight) return inflight;
  inflight = executeSilentWebLogin(apiFetch).finally(() => {
    inflight = null;
  });
  return inflight;
}
