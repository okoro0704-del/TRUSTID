import {
  base64URLStringToBuffer,
  bufferToBase64URLString,
  startAuthentication,
} from "@simplewebauthn/browser";
import type { AuthOptions } from "../components/TrustIdLoginButton.js";
import type { TrustIdIdentity } from "../types.js";

/** Hard ceiling so a missing/deleted passkey never leaves the UI spinning. */
export let WEBAUTHN_PROBE_TIMEOUT_MS = 5000;

/** Test-only override for probe wall-clock. */
export function __setWebAuthnProbeTimeoutMs(ms: number) {
  WEBAUTHN_PROBE_TIMEOUT_MS = ms;
}

export type SilentAssertIdentityResult = {
  identity: TrustIdIdentity;
  trustId?: string;
  sessionId?: string;
  mode?: string;
};

const ATTEMPTED_KEY = "trustid.silent_auto_login.attempted";

const STALE_AUTH_KEYS = [
  ATTEMPTED_KEY,
  "trustid.rememberedAccount",
  "trustid.onboarding",
  "trustid.device.occupancy",
] as const;

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

function webAuthnError(name: string, message: string): DOMException {
  try {
    return new DOMException(message, name);
  } catch {
    const err = new Error(message);
    err.name = name;
    return err as DOMException;
  }
}

/**
 * Race a WebAuthn call against a hard wall-clock timeout.
 * Browsers often ignore short `publicKey.timeout` values when no credential exists.
 */
export function withWebAuthnTimeout<T>(
  promise: Promise<T>,
  ms: number = WEBAUTHN_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        webAuthnError(
          "TimeoutError",
          `WebAuthn timed out after ${ms}ms (no passkey presented)`,
        ),
      );
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function isWebAuthnFailure(err: unknown): boolean {
  if (!err) return true;
  const name =
    err instanceof DOMException
      ? err.name
      : err instanceof Error
        ? err.name
        : "";
  const message = err instanceof Error ? err.message : String(err);
  return /NotAllowedError|InvalidStateError|AbortError|TimeoutError|NotSupportedError|SecurityError|UnknownError|not allowed|abort|cancel|no credentials|timed out|timeout|unknown credential|invalid state|not supported|constraint/i.test(
    `${name} ${message}`,
  );
}

/**
 * Instant discoverable-credential assertion with a hard 5s ceiling.
 * Single probe path (no conditional-autofill cascade) so deleted keys fail fast.
 */
export async function runImmediateSilentPasskey(optionsJSON: AuthOptions) {
  const publicKeyJson: AuthOptions = {
    ...optionsJSON,
    timeout: Math.min(
      optionsJSON.timeout ?? WEBAUTHN_PROBE_TIMEOUT_MS,
      WEBAUTHN_PROBE_TIMEOUT_MS,
    ),
    allowCredentials: optionsJSON.allowCredentials?.length
      ? optionsJSON.allowCredentials
      : [],
  };
  const publicKey = toPublicKeyRequestOptions(publicKeyJson);

  try {
    if (typeof navigator !== "undefined" && navigator.credentials?.get) {
      const cred = (await withWebAuthnTimeout(
        navigator.credentials.get({
          publicKey,
          mediation: "optional",
        } as CredentialRequestOptions) as Promise<PublicKeyCredential | null>,
      )) as PublicKeyCredential | null;
      if (cred) return assertionFromCredential(cred);
      throw webAuthnError(
        "NotAllowedError",
        "No Trust ID passkey on this device",
      );
    }

    return await withWebAuthnTimeout(
      startAuthentication({ optionsJSON: publicKeyJson }),
    );
  } catch (err) {
    if (isWebAuthnFailure(err)) {
      throw webAuthnError(
        "NotAllowedError",
        err instanceof Error
          ? err.message
          : "No Trust ID passkey on this device",
      );
    }
    throw err;
  }
}

/** Fetch discoverable login options (zero identity fields). */
export async function fetchSilentLoginOptions(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<AuthOptions> {
  const raw = await apiFetch<
    AuthOptions & { challengeId?: string; purpose?: string }
  >("/auth/webauthn/login/options", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const { challengeId: _c, purpose: _p, ...optionsJSON } = raw;
  void _c;
  void _p;
  return {
    ...optionsJSON,
    timeout: Math.min(
      optionsJSON.timeout ?? WEBAUTHN_PROBE_TIMEOUT_MS,
      WEBAUTHN_PROBE_TIMEOUT_MS,
    ),
  };
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
 * Rejects quickly when no passkey is available.
 */
export async function executeSilentWebLogin(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<SilentAssertIdentityResult> {
  const options = await fetchSilentLoginOptions(apiFetch);
  const assertion = await runImmediateSilentPasskey(options);
  return postSilentWebAuthnAssert(apiFetch, assertion);
}

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

/** Drop in-flight silent login so a hung probe cannot poison retries. */
export function resetSilentWebLoginInflight(): void {
  inflight = null;
}

/**
 * Clear stale session/auth hints after a failed or missing passkey probe.
 * Keeps the stable install id so register-silent can still bind the device.
 */
export function clearStaleAuthCaches(): void {
  clearSilentAutoLoginAttempt();
  resetSilentWebLoginInflight();
  for (const key of STALE_AUTH_KEYS) {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    } catch {
      /* ignore quota / privacy mode */
    }
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

let inflight: Promise<SilentAssertIdentityResult> | null = null;

/** Deduped silent web login (safe under React StrictMode double-mount). */
export function executeSilentWebLoginOnce(
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<SilentAssertIdentityResult> {
  if (inflight) return inflight;
  // Hard wall-clock for options fetch + WebAuthn so the UI never spins forever.
  inflight = withWebAuthnTimeout(
    executeSilentWebLogin(apiFetch),
    WEBAUTHN_PROBE_TIMEOUT_MS + 2500,
  ).finally(() => {
    inflight = null;
  });
  return inflight;
}
