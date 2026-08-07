import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api";

export type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

export type LoginHints = {
  email?: string;
  phone?: string;
  trustId?: string;
};

type CacheEntry = {
  key: string;
  options: AuthOptions;
  fetchedAt: number;
};

const MAX_AGE_MS = 90_000;

function hintsKey(hints: LoginHints) {
  return [
    hints.trustId?.trim() ?? "",
    hints.email?.trim().toLowerCase() ?? "",
    hints.phone?.trim() ?? "",
  ].join("|");
}

function cleanHints(hints: LoginHints = {}): LoginHints {
  const email = hints.email?.trim() || undefined;
  const phone = hints.phone?.trim() || undefined;
  const trustId = hints.trustId?.trim() || undefined;
  return { email, phone, trustId };
}

function stripServerExtras(
  raw: AuthOptions & { challengeId?: string; purpose?: string },
): AuthOptions {
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

  async function fetchOptions(hints: LoginHints = {}): Promise<AuthOptions> {
    const cleaned = cleanHints(hints);
    const raw = await api<AuthOptions & { challengeId?: string; purpose?: string }>(
      "/auth/webauthn/login/options",
      {
        method: "POST",
        body: JSON.stringify({
          trustId: cleaned.trustId,
          email: cleaned.email,
          phone: cleaned.phone,
        }),
      },
    );
    return stripServerExtras(raw);
  }

  function peek(hints: LoginHints = {}): AuthOptions | null {
    if (!entry) return null;
    if (entry.key !== hintsKey(cleanHints(hints))) return null;
    if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return null;
    return entry.options;
  }

  async function prefetch(hints: LoginHints = {}): Promise<void> {
    const cleaned = cleanHints(hints);
    const key = hintsKey(cleaned);
    if (peek(cleaned)) return;
    if (inflight && inflightKey === key) {
      await inflight.catch(() => undefined);
      return;
    }
    inflightKey = key;
    inflight = fetchOptions(cleaned)
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
  async function take(hints: LoginHints = {}): Promise<AuthOptions> {
    const cleaned = cleanHints(hints);
    const key = hintsKey(cleaned);
    const cached = peek(cleaned);
    if (cached) {
      entry = null;
      return cached;
    }
    if (inflight && inflightKey === key) {
      const options = await inflight;
      entry = null;
      return options;
    }
    const options = await fetchOptions(cleaned);
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
