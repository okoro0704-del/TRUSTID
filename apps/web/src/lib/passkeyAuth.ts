import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api";

export type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

type CacheEntry = {
  key: string;
  options: AuthOptions;
  fetchedAt: number;
};

const MAX_AGE_MS = 90_000;

function contactKey(email?: string, phone?: string) {
  return `${email?.trim().toLowerCase() ?? ""}|${phone?.trim() ?? ""}`;
}

function stripServerExtras(raw: AuthOptions & { challengeId?: string; purpose?: string }): AuthOptions {
  const { challengeId: _c, purpose: _p, ...optionsJSON } = raw;
  void _c;
  void _p;
  return optionsJSON;
}

/**
 * Prefetch + single-use cache for WebAuthn login options.
 * Android Chrome drops user activation if options fetch (Netlify→Railway)
 * runs after the tap and before credentials.get(); iOS is more forgiving.
 */
export function createLoginOptionsCache() {
  let entry: CacheEntry | null = null;
  let inflight: Promise<AuthOptions> | null = null;
  let inflightKey = "";

  async function fetchOptions(email?: string, phone?: string): Promise<AuthOptions> {
    const raw = await api<AuthOptions & { challengeId?: string; purpose?: string }>(
      "/auth/webauthn/login/options",
      {
        method: "POST",
        body: JSON.stringify({
          email: email?.trim() || undefined,
          phone: phone?.trim() || undefined,
        }),
      },
    );
    return stripServerExtras(raw);
  }

  function peek(email?: string, phone?: string): AuthOptions | null {
    if (!entry) return null;
    if (entry.key !== contactKey(email, phone)) return null;
    if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return null;
    return entry.options;
  }

  async function prefetch(email?: string, phone?: string): Promise<void> {
    const key = contactKey(email, phone);
    if (peek(email, phone)) return;
    if (inflight && inflightKey === key) {
      await inflight.catch(() => undefined);
      return;
    }
    inflightKey = key;
    inflight = fetchOptions(email, phone)
      .then((options) => {
        entry = { key, options, fetchedAt: Date.now() };
        return options;
      })
      .finally(() => {
        inflight = null;
        inflightKey = "";
      });
    await inflight.catch(() => undefined);
  }

  /** Take cached options (single-use) or fetch now. */
  async function take(email?: string, phone?: string): Promise<AuthOptions> {
    const key = contactKey(email, phone);
    const cached = peek(email, phone);
    if (cached) {
      entry = null;
      return cached;
    }
    if (inflight && inflightKey === key) {
      const options = await inflight;
      entry = null;
      return options;
    }
    const options = await fetchOptions(email, phone);
    entry = null;
    return options;
  }

  function invalidate() {
    entry = null;
    inflight = null;
    inflightKey = "";
  }

  return { prefetch, take, invalidate, peek };
}

export async function runPasskeyLogin(optionsJSON: AuthOptions) {
  return startAuthentication({ optionsJSON });
}
